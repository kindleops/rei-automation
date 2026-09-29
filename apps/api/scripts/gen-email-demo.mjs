/**
 * Writes the dashboard's ?demo=1 Email Command data by running raw scenario
 * rows through the REAL read model (email-command-service.js) over the
 * in-memory database. Demo data is never served by the API, is always
 * labelled DEMO in the UI, and cannot write. Timestamps are shifted to "now"
 * on load. Re-run after changing the model:
 *   node --import ./tests/register-aliases.mjs scripts/gen-email-demo.mjs
 */
import { writeFileSync } from 'node:fs'
import { makeEmailDb } from '../tests/helpers/email-db-mock.mjs'
import { getEmailCommandHome, getEmailCommandThread, getEmailMessageTelemetry } from '../src/lib/domain/email/email-command-service.js'

const NOW = Date.now()
const at = (h) => new Date(NOW + h * 3600e3).toISOString()
const T = (id, o) => ({ id, reply_token: `${id}`.padEnd(16, '0'), automation_state: 'active', resolution_status: 'resolved', needs_operator: false, inbound_count: 0, outbound_count: 0, attachment_count: 0, created_at: at(-72), ...o })
const Q = (id, o) => ({ id, queue_key: `demo:${id}`, approval_status: 'not_required', provider: 'brevo', from_email: 'ryan@reivesti.com', from_name: 'Ryan · REIVESTI', sender_key: 'reivesti', sending_domain: 'reivesti.com', created_at: o.sent_at || o.scheduled_for || at(-1), ...o })
const E = (q, type, h, extra = {}) => ({ event_key: `demo:${q}:${type}:${h}`, queue_id: q, event_type: type, event_at: at(h), direction: 'outbound', event_source: 'brevo_webhook', ...extra })

const db = makeEmailDb({
  email_threads: [
    T('th-david', { thread_key: 'seller:mo-1:p-1', category: 'seller', counterparty_email: 'david.larson@gmail.com', counterparty_name: 'David Larson', counterparty_role: 'seller', master_owner_id: 'mo-1', property_id: 'p-1', sms_thread_key: '+16125550123', subject: 'Re: 4157 Pillsbury Ave S', contact_preference: 'email', last_inbound_at: at(-0.2), last_outbound_at: at(-0.15), last_message_at: at(-0.15), last_message_direction: 'outbound', last_message_preview: 'Thanks David. Is anyone living there right now, and does it need any major repairs?', inbound_count: 1, outbound_count: 2 }),
    T('th-west', { thread_key: 'closing:c-1:title', category: 'title', counterparty_email: 'lisa@westtitle.com', counterparty_name: 'West Title', counterparty_role: 'title', closing_case_id: 'c-1', property_id: 'p-2', subject: '1201 Oak Grove Dr, Dallas, TX', last_inbound_at: at(-20), last_outbound_at: at(-44), last_message_at: at(-20), last_message_direction: 'inbound', last_message_preview: 'Received the order, file WT-22817. We expect the commitment by Thursday.', inbound_count: 1, outbound_count: 1 }),
    T('th-summit', { thread_key: 'closing:c-2:title', category: 'title', counterparty_email: 'escrow@summittitle.com', counterparty_name: 'Summit Title', counterparty_role: 'title', closing_case_id: 'c-2', property_id: 'p-3', subject: '88 Harbor View Rd, Tampa, FL', needs_operator: true, needs_code: 'title_issue', needs_reason: 'Title reports open lien and needs direction: "We found an unreleased mortgage from 2014. Need direction."', needs_since: at(-0.4), last_inbound_at: at(-0.4), last_outbound_at: at(-30), last_message_at: at(-0.4), last_message_direction: 'inbound', last_message_preview: 'We found an unreleased mortgage from 2014. Need direction on how you would like to proceed.', inbound_count: 1, outbound_count: 1, attachment_count: 1 }),
    T('th-buyer', { thread_key: 'closing:c-2:buyer', category: 'buyer', counterparty_email: 'acq@northpointcapital.com', counterparty_name: 'Northpoint Capital', counterparty_role: 'buyer', closing_case_id: 'c-2', property_id: 'p-3', subject: '88 Harbor View Rd, Tampa, FL', last_outbound_at: at(-5), last_message_at: at(-5), last_message_direction: 'outbound', last_message_preview: 'Following up on the agreement for 88 Harbor View Rd.', outbound_count: 1 }),
    T('th-maria', { thread_key: 'seller:mo-4:p-4', category: 'seller', counterparty_email: 'maria.g@outlook.com', counterparty_name: 'Maria Gonzalez', counterparty_role: 'seller', master_owner_id: 'mo-4', property_id: 'p-4', sms_thread_key: '+13055550188', subject: 'Your house on Birch St', last_outbound_at: at(-26), last_message_at: at(-26), last_message_direction: 'outbound', last_message_preview: 'Hi Maria, would you consider an offer on 22 Birch St?', outbound_count: 1 }),
    T('th-unknown', { thread_key: 'unresolved:info@propertyleadsdaily.com', category: 'unresolved', counterparty_email: 'info@propertyleadsdaily.com', resolution_status: 'unresolved', subject: 'Partnership opportunity', last_inbound_at: at(-3), last_message_at: at(-3), last_message_direction: 'inbound', last_message_preview: 'We help investors find off-market deals…', inbound_count: 1 }),
  ],
  email_queue: [
    Q('q-d1', { thread_id: 'th-david', to_email: 'david.larson@gmail.com', subject: 'Your house on Pillsbury Ave', text_body: 'Hi David, would you consider an offer on 4157 Pillsbury Ave S?', queue_status: 'delivered', sent_at: at(-50), source: 'campaign', lane: 'acquisition', campaign_id: 'Minneapolis seller email', sequence_step: 1, template_id: 'seller.consider_selling', template_version: 'v2', master_owner_id: 'mo-1', property_id: 'p-1', reason: { why: 'Campaign touch 1' } }),
    Q('q-d2', { thread_id: 'th-david', to_email: 'david.larson@gmail.com', subject: 'Re: 4157 Pillsbury Ave S', text_body: 'Thanks David. Is anyone living there right now, and does it need any major repairs?', queue_status: 'sent', sent_at: at(-0.15), source: 'seller', lane: 'seller_conversation', action_key: 'seller.reply.condition_probe', master_owner_id: 'mo-1', property_id: 'p-1', reason: { why: 'Seller replied by email', use_case: 'condition_probe', audit_reason: 'asking_price_provided' } }),
    Q('q-w1', { thread_id: 'th-west', to_email: 'lisa@westtitle.com', subject: 'New title order — 1201 Oak Grove Dr', text_body: 'Hello West Title team,\n\nPlease open title for the property below.\n\nProperty: 1201 Oak Grove Dr, Dallas, TX', queue_status: 'delivered', sent_at: at(-44), source: 'closing', lane: 'closing', action_key: 'closing.title_open', sequence: 1, reason: { why: 'Contract executed; title routed', category: 'title_open' } }),
    Q('q-w2', { thread_id: 'th-west', to_email: 'lisa@westtitle.com', subject: 'Re: Title commitment — 1201 Oak Grove Dr (File WT-22817)', text_body: 'Checking on the title commitment for 1201 Oak Grove Dr (file WT-22817).', queue_status: 'scheduled', scheduled_for: at(18), source: 'closing', lane: 'closing', action_key: 'closing.title_commitment_reminder', sequence: 2, created_at: at(-1), reason: { why: 'Title commitment has not been received', category: 'title_commitment', sequence: 2, due_at: at(40) } }),
    Q('q-s1', { thread_id: 'th-summit', to_email: 'escrow@summittitle.com', subject: 'New title order — 88 Harbor View Rd', text_body: 'Please open title for 88 Harbor View Rd, Tampa, FL.', queue_status: 'delivered', sent_at: at(-30), source: 'closing', lane: 'closing', action_key: 'closing.title_open', sequence: 1 }),
    Q('q-b1', { thread_id: 'th-buyer', to_email: 'acq@northpointcapital.com', subject: 'Assignment agreement — 88 Harbor View Rd', text_body: 'Following up on the agreement for 88 Harbor View Rd. Let us know if you have any questions before signing.', queue_status: 'delivered', sent_at: at(-5), source: 'closing', lane: 'buyer', action_key: 'closing.buyer_agreement_followup', sequence: 1, reason: { why: 'Agreement sent 2 days ago, not signed', category: 'buyer_agreement' } }),
    Q('q-m1', { thread_id: 'th-maria', to_email: 'maria.g@outlook.com', subject: 'Your house on Birch St', text_body: 'Hi Maria, would you consider an offer on 22 Birch St?', queue_status: 'bounced', sent_at: at(-26), updated_at: at(-25.9), failed_reason: 'mailbox does not exist', source: 'campaign', lane: 'acquisition', campaign_id: 'Miami seller email', sequence_step: 1, master_owner_id: 'mo-4', property_id: 'p-4' }),
  ],
  email_events: [
    E('q-d1', 'sent', -50), E('q-d1', 'accepted', -50, { event_source: 'provider_api' }), E('q-d1', 'delivered', -49.9),
    E('q-d1', 'open_signal', -49.5, { signal_class: 'privacy_proxy' }), E('q-d1', 'open_signal', -1, { signal_class: 'likely_human' }), E('q-d1', 'open_signal', -0.5, { signal_class: 'likely_human' }), E('q-d1', 'replied', -0.2, { event_source: 'cloudflare_inbound_email' }),
    E('q-d2', 'sent', -0.15), E('q-d2', 'accepted', -0.15, { event_source: 'provider_api' }),
    E('q-w1', 'sent', -44), E('q-w1', 'delivered', -43.9), E('q-w1', 'replied', -20, { event_source: 'cloudflare_inbound_email' }),
    E('q-s1', 'sent', -30), E('q-s1', 'delivered', -29.9), E('q-s1', 'replied', -0.4, { event_source: 'cloudflare_inbound_email' }),
    E('q-b1', 'sent', -5), E('q-b1', 'delivered', -4.9), E('q-b1', 'open_signal', -3, { signal_class: 'unknown' }),
    E('q-m1', 'sent', -26), E('q-m1', 'hard_bounce', -25.9, { reason: 'mailbox does not exist' }),
  ],
  email_inbound_messages: [
    { id: 'in-d1', dedupe_key: 'd1', thread_id: 'th-david', from_email: 'david.larson@gmail.com', from_name: 'David Larson', subject: 'Re: Your house on Pillsbury Ave', text_body: "Yes, but I'd need around $315k.\n\nOn Sun, Sep 27 Ryan wrote:\n> Would you consider an offer?", reply_text: "Yes, but I'd need around $315k.", received_at: at(-0.2), processing_status: 'handled', handled_at: at(-0.19), classification: { primary_intent: 'asking_price_provided', facts: { asking_price: { value: { amount: 315000 } } }, stage_after: 'property_condition', next_use_case: 'condition_probe', replied_by: 'email', sms_followups_cancelled: 1 } },
    { id: 'in-w1', dedupe_key: 'w1', thread_id: 'th-west', from_email: 'lisa@westtitle.com', from_name: 'Lisa Park', subject: 'RE: New title order — 1201 Oak Grove Dr', text_body: 'Received the order, file WT-22817. We expect the commitment by Thursday.\n-- \nLisa Park\nEscrow Officer · West Title', reply_text: 'Received the order, file WT-22817. We expect the commitment by Thursday.', signature_text: 'Lisa Park\nEscrow Officer · West Title', received_at: at(-20), processing_status: 'handled', handled_at: at(-19.99), classification: { assertions: [], applied: [{ type: 'title_acknowledged', ok: true }, { type: 'commitment_due', ok: true, value: 'Thu' }] } },
    { id: 'in-s1', dedupe_key: 's1', thread_id: 'th-summit', from_email: 'escrow@summittitle.com', from_name: 'Summit Title Escrow', subject: 'RE: 88 Harbor View Rd', text_body: 'We found an unreleased mortgage from 2014. Need direction on how you would like to proceed.', reply_text: 'We found an unreleased mortgage from 2014. Need direction on how you would like to proceed.', received_at: at(-0.4), processing_status: 'needs_operator', classification: { flags: [], applied: [{ type: 'title_issue', ok: true, value: 'open_lien' }] }, attachment_count: 1 },
    { id: 'in-u1', dedupe_key: 'u1', thread_id: 'th-unknown', from_email: 'info@propertyleadsdaily.com', subject: 'Partnership opportunity', text_body: 'We help investors find off-market deals…', reply_text: 'We help investors find off-market deals…', received_at: at(-3), processing_status: 'unresolved' },
  ],
  email_attachments: [
    { id: 'att-1', attachment_key: 'demo-att-1', inbound_message_id: 'in-s1', thread_id: 'th-summit', filename: 'Prelim Title Report 88 Harbor View.pdf', content_type: 'application/pdf', size_bytes: 412000, doc_type: 'title_commitment', classification_confidence: 0.6, review_state: 'needs_review', fetch_status: 'stored' },
  ],
  closing_cases: [
    { closing_case_id: 'c-1', property_address: '1201 Oak Grove Dr, Dallas, TX', title_acknowledged_at: at(-20), title_commitment_date: new Date(NOW + 44 * 3600e3).toISOString().slice(0, 10) + 'T00:00:00Z', scheduled_closing_date: at(24 * 16) },
    { closing_case_id: 'c-2', property_address: '88 Harbor View Rd, Tampa, FL', title_acknowledged_at: at(-28), title_commitment_received_at: at(-2), automation_paused_at: at(-0.39) },
  ],
  closing_activity_events: [
    { closing_case_id: 'c-1', event_type: 'title_acknowledged', source: 'title_email', created_at: at(-19.99) },
    { closing_case_id: 'c-1', event_type: 'title_commitment_date_set', source: 'title_email', created_at: at(-19.99) },
    { closing_case_id: 'c-2', event_type: 'title_issue_opened', source: 'title_email', created_at: at(-0.39) },
  ],
  inbox_thread_state: [
    { thread_key: '+16125550123', seller_stage: 'property_condition', seller_display_name: 'David Larson', contactability_status: 'contactable' },
    { thread_key: '+13055550188', seller_stage: 'ownership_confirmation', seller_display_name: 'Maria Gonzalez', contactability_status: 'contactable' },
  ],
  acquisition_opportunities: [{ id: 'opp-1', master_owner_id: 'mo-1', property_id: 'p-1', acquisition_stage: 'property_condition', metadata: { seller_facts: { asking_price: { value: { amount: 315000 } } } } }],
  properties: [
    { property_id: 'p-1', property_address_full: '4157 Pillsbury Ave S, Minneapolis, MN' },
    { property_id: 'p-2', property_address_full: '1201 Oak Grove Dr, Dallas, TX' },
    { property_id: 'p-3', property_address_full: '88 Harbor View Rd, Tampa, FL' },
    { property_id: 'p-4', property_address_full: '22 Birch St, Miami, FL' },
  ],
  system_control: [{ key: 'email_enabled', value: 'true' }],
})
db.storage = { from: () => ({ createSignedUrl: async () => ({ data: null }) }) }

process.env.EMAIL_SEND_ENABLED = 'true'
const home = await getEmailCommandHome({}, { supabase: db })
const threads = {}
for (const t of db.state.email_threads) threads[t.id] = await getEmailCommandThread(t.id, { supabase: db })
const messages = {}
for (const q of db.state.email_queue) messages[q.id] = await getEmailMessageTelemetry(q.id, { supabase: db })
writeFileSync(new URL('../../dashboard/src/views/email-command/mobile/email-demo.generated.json', import.meta.url), JSON.stringify({ generatedAt: new Date(NOW).toISOString(), home, threads, messages }) + '\n')
console.log('wrote demo:', Object.entries(home.counts).map(([k, v]) => `${k}=${v}`).join(' '))
