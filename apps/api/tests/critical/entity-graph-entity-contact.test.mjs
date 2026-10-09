/**
 * Owner P0 (2026-10-09): a property whose entity contact needs role review
 * (seller.property_entity_contact_v1 requires_review · contact_role unknown ·
 * ENT_ROLE_UNCORROBORATED — 24,717 rows, 20,059 with a selected phone) shows
 * its candidate contact, never "No phone". Display only: SMS eligibility stays
 * the campaign target graph's verdict; the phone leaves the server masked.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { getEntityGraphOutreachState, shapeEntityContact } from '../../src/lib/domain/entity-graph/entity-graph-outreach-state.js'

const EC_ROW = { property_id: '24507162', owning_entity_name: 'STONEBRIDGE HOLDINGS LLC', entity_status: 'active', selected_person_key: 'ik_1', contact_role: 'unknown', selected_phone: '+15550104477', phone_callable: true, has_email: false, email_usable: false, exclusion_reasons: ['ENT_ROLE_UNCORROBORATED'], requires_review: true, person_name: 'Ana Ruiz' }

test('shapeEntityContact: masked phone, callable flag, "Unknown · needs review", labelled reasons', () => {
  const ec = shapeEntityContact(EC_ROW)
  assert.equal(ec.phoneMasked, '•••-4477')
  assert.equal(ec.phoneCallable, true)
  assert.equal(ec.roleLabel, 'Unknown · needs review')
  assert.equal(ec.person, 'Ana Ruiz')
  assert.deepEqual(ec.reviewReasons, [{ code: 'ENT_ROLE_UNCORROBORATED', label: "The person's role at the entity is not corroborated" }])
  assert.ok(!JSON.stringify(ec).includes('5550104477'))
  assert.equal(shapeEntityContact({ ...EC_ROW, selected_phone: null, exclusion_reasons: ['ENT_NO_HUMAN_CANDIDATE'], selected_person_key: null, person_name: null }).person, null)
})

test('outreach state: a review-blocked property carries its entity contact; eligibility is NOT loosened', async () => {
  const from = (table) => {
    const rows = table === 'campaign_target_graph' ? [{ property_id: '24507162', queue_eligible: true, seller_person_key: 'ik_1', canonical_e164: '+15550104477', timezone: 'America/Chicago', identity_alignment: 'verified' }] : []
    const q = { select() { return q }, in() { return q }, eq() { return q }, or() { return q }, contains() { return q }, limit() { return q }, then(res, rej) { return Promise.resolve({ data: rows, error: null }).then(res, rej) } }
    return q
  }
  const supabase = { from, rpc: async (name) => ({ data: name === 'campaign_entity_contact_review_flags' ? [{ property_id: '24507162', requires_review: true }] : [], error: null }) }
  const queries = []
  const query = async (sql, params) => { queries.push(params[0]); return { rows: [EC_ROW] } }
  const { states } = await getEntityGraphOutreachState({ property_ids: '24507162' }, { supabase, query })
  const st = states['24507162']
  assert.equal(st.sms.eligible, false, 'still blocked by the campaign graph rule')
  assert.equal(st.sms.reason, 'entity_contact_requires_review')
  assert.equal(st.entityContact.phoneMasked, '•••-4477')
  assert.equal(st.entityContact.roleLabel, 'Unknown · needs review')
  assert.deepEqual(queries, [['24507162']], 'one keyed read for the review-blocked ids')
  assert.ok(!JSON.stringify(st.entityContact).includes('+1555'))
})
