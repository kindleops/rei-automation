import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  HOLD_REASONS, RULES, TIERS, IDENTITY_HOLD_SHADOW_FLAG,
  isIdentityHoldShadowEnabled, identityHoldReasons, evaluateIdentityHoldShadow,
  evaluateCoOwnerPhoneLink, evaluateSamePersonPhone, evaluateEntityPrincipalMailing,
  evaluateEntityAlternatePrincipal, entityIsOwnerOfRecord, summarizeIdentityHoldShadow,
} from '../../src/lib/domain/campaigns/identity-hold-shadow.js'

const linkageRow = (over = {}) => ({
  queue_eligible: true,
  phone: '6125550101',
  seller_person_key: null,
  resolution: {
    status: 'ambiguous', co_owner_individual_key: 'p2',
    deed_owner_name: 'Saul Cordova', operational_owner_name: 'Saul & Guillermina Cordova',
  },
  phone_holders: [{ individual_key: 'p2', given_name: 'Guillermina', surname: 'Cordova', full_name: 'Guillermina Cordova', likely_owner: false, likely_renting: false, phone_dnc: false }],
  ...over,
})

const entityRow = (over = {}, person = {}, entity = {}) => ({
  queue_eligible: true,
  phone: '6125550102',
  seller_person_key: 'p9',
  owner_name: 'Key Prop Rental & Sales LLC',
  entity: {
    requires_review: true, exclusion_reasons: ['ENT_ROLE_UNCORROBORATED'], evidence_codes: ['ENT_VENDOR_OWNER_BIT'],
    entity_status: 'active', owning_entity_name: 'Key Prop Rental & Sales LLC', selected_person_key: 'p9', ...entity,
  },
  person: {
    matching_type: 'mailing_address', matches_property_owner: true, likely_owner: false, likely_renting: false,
    in_portfolio: true, phone_is_own: true, phone_dnc: false, entity_fanout: 1, given_name: 'Kevin', surname: 'Lockwood',
    full_name: 'Kevin C Lockwood', registry_officer_roles: [], ...person,
  },
  ...over,
})

const altPrincipal = (over = {}) => ({
  individual_key: 'p7', full_name: 'Laura M Aparicio', given_name: 'Laura', surname: 'Aparicio',
  matching_type: 'mailing_address', matches_property_owner: true, likely_renting: false,
  phone: '2145550199', phone_type: 'W', slot: 1, phone_dnc: false, phone_suppressed: false, ...over,
})

test('the shadow flag defaults OFF and only explicit values turn it on', () => {
  assert.equal(isIdentityHoldShadowEnabled({}, {}), false)
  assert.equal(isIdentityHoldShadowEnabled({}, { [IDENTITY_HOLD_SHADOW_FLAG]: 'yes please' }), false)
  assert.equal(isIdentityHoldShadowEnabled({}, { [IDENTITY_HOLD_SHADOW_FLAG]: 'on' }), true)
  assert.equal(isIdentityHoldShadowEnabled({ identity_hold_shadow: true }, {}), true)
})

test('the evaluator is pure: no imports, no I/O, nothing that can write', () => {
  const src = fs.readFileSync(new URL('../../src/lib/domain/campaigns/identity-hold-shadow.js', import.meta.url), 'utf8')
  assert.equal(/^\s*import\s/m.test(src), false)
  assert.equal(/supabase|fetch\(|\.from\(|insert|update\(|upsert/i.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')), false)
})

test('every identity hold on a row is reported, primary in live precedence order', () => {
  const r = identityHoldReasons({ seller_person_key: null, phone: '1', entity: { requires_review: null }, phone_group: { distinct_master_owners: 2 } })
  assert.deepEqual(r.reasons, [HOLD_REASONS.MISSING_IDENTITY_LINKAGE, HOLD_REASONS.ENTITY_CONTACT_REQUIRES_REVIEW, HOLD_REASONS.AMBIGUOUS_PHONE_OWNERSHIP])
  assert.equal(r.primary, HOLD_REASONS.MISSING_IDENTITY_LINKAGE)
  assert.deepEqual(identityHoldReasons({ seller_person_key: 'p', phone: '1', entity: { requires_review: false } }).reasons, [])
})

test('R1 releases a co-owner on title whose phone it is (ambiguous → A, conflicting → B)', () => {
  const a = evaluateCoOwnerPhoneLink(linkageRow())
  assert.equal(a.outcome, 'release')
  assert.equal(a.tier, TIERS.A)
  assert.equal(a.evidence.resolved_person_key, 'p2')
  const b = evaluateCoOwnerPhoneLink(linkageRow({ resolution: { ...linkageRow().resolution, status: 'conflicting_existing_assignment' } }))
  assert.equal(b.tier, TIERS.B)
})

test('R1 holds: not the co-owner, not on title, shared phone, renter, DNC, no holder', () => {
  assert.equal(evaluateCoOwnerPhoneLink(linkageRow({ resolution: { ...linkageRow().resolution, co_owner_individual_key: 'p3' } })).hold, 'holder_is_not_resolver_co_owner')
  assert.equal(evaluateCoOwnerPhoneLink(linkageRow({ resolution: { ...linkageRow().resolution, deed_owner_name: 'Saul Cordova', operational_owner_name: 'Saul Cordova' } })).hold, 'holder_name_not_on_title')
  assert.equal(evaluateCoOwnerPhoneLink(linkageRow({ phone_holders: [linkageRow().phone_holders[0], { individual_key: 'p5' }] })).hold, 'phone_shared_by_multiple_linked_people')
  assert.equal(evaluateCoOwnerPhoneLink(linkageRow({ phone_holders: [{ ...linkageRow().phone_holders[0], likely_renting: true }] })).hold, 'renter_not_owner')
  assert.equal(evaluateCoOwnerPhoneLink(linkageRow({ phone_holders: [{ ...linkageRow().phone_holders[0], phone_dnc: true }] })).hold, 'vendor_dnc_on_phone')
  assert.equal(evaluateCoOwnerPhoneLink(linkageRow({ phone_holders: [] })).hold, 'no_property_linked_holder_of_phone')
})

test('R2 releases a phone whose rows are one canonical person split across legacy owner ids', () => {
  const ok = evaluateSamePersonPhone({ phone_group: { distinct_master_owners: 2, distinct_person_keys: 1, null_person_rows: 0, person_key: 'p1', rows: 3 } })
  assert.equal(ok.outcome, 'release')
  assert.equal(evaluateSamePersonPhone({ phone_group: { distinct_master_owners: 2, distinct_person_keys: 2, null_person_rows: 0 } }).hold, 'phone_held_by_multiple_people')
  assert.equal(evaluateSamePersonPhone({ phone_group: { distinct_master_owners: 2, distinct_person_keys: 1, null_person_rows: 1 } }).hold, 'a_row_on_phone_has_no_person')
})

test('R3 releases the vendor-matched principal at the entity mailing address', () => {
  const r = evaluateEntityPrincipalMailing(entityRow())
  assert.equal(r.outcome, 'release')
  assert.equal(r.tier, TIERS.A)
  assert.equal(r.evidence.owner_of_record_basis, 'entity_name_match')
})

test('R3 never releases the occupant of an entity-owned house (tenant)', () => {
  const r = evaluateEntityPrincipalMailing(entityRow({}, { matching_type: 'property_address', matches_property_owner: false }))
  assert.equal(r.hold, 'occupant_not_owner')
})

test('R3: unknown never counts as a match', () => {
  assert.equal(evaluateEntityPrincipalMailing(entityRow({}, { matches_property_owner: null })).hold, 'vendor_owner_match_not_true')
  assert.equal(evaluateEntityPrincipalMailing(entityRow({}, { in_portfolio: null })).hold, 'property_not_in_person_portfolio')
  assert.equal(evaluateEntityPrincipalMailing(entityRow({}, { phone_is_own: null })).hold, 'phone_not_persons_own_record')
  assert.equal(evaluateEntityPrincipalMailing(entityRow({ person: null })).hold, 'person_record_missing')
})

test('R3 holds DNC, renters, institutions, bank REO, dissolved, agents and mis-linked entities', () => {
  assert.equal(evaluateEntityPrincipalMailing(entityRow({}, { phone_dnc: true })).hold, 'vendor_dnc_on_phone')
  assert.equal(evaluateEntityPrincipalMailing(entityRow({}, { likely_renting: true })).hold, 'renter_not_owner')
  assert.equal(evaluateEntityPrincipalMailing(entityRow({ owner_name: 'First Baptist Church' }, {}, { owning_entity_name: 'First Baptist Church' })).hold, 'institutional_entity')
  assert.equal(evaluateEntityPrincipalMailing(entityRow({}, {}, { evidence_codes: ['ENT_BANK_REO'] })).hold, 'bank_reo')
  assert.equal(evaluateEntityPrincipalMailing(entityRow({}, {}, { exclusion_reasons: ['ENT_DISSOLVED'] })).hold, 'entity_dissolved')
  assert.equal(evaluateEntityPrincipalMailing(entityRow({ owner_name: 'Acme Registered Agent LLC' }, {}, { owning_entity_name: 'Acme Registered Agent LLC' })).hold, 'registered_agent_or_law_firm')
  assert.equal(evaluateEntityPrincipalMailing(entityRow({}, { registry_officer_roles: ['agent'] })).hold, 'registered_agent_only')
  assert.equal(evaluateEntityPrincipalMailing(entityRow({ owner_name: 'Keverry Montrose LLC' }, {}, { owning_entity_name: 'American Youth Hostels, Inc.' })).hold, 'entity_not_owner_of_record')
  assert.equal(evaluateEntityPrincipalMailing(entityRow({ owner_name: 'Current Owner' }, {}, { owning_entity_name: 'Current Owner' })).hold, 'owner_name_placeholder')
})

test('R3 tiers by how many entities the person fronts; a registry officer role is tier A', () => {
  assert.equal(evaluateEntityPrincipalMailing(entityRow({}, { entity_fanout: 6 })).tier, TIERS.B)
  assert.equal(evaluateEntityPrincipalMailing(entityRow({}, { entity_fanout: 40 })).hold, 'person_fronts_many_entities')
  assert.equal(evaluateEntityPrincipalMailing(entityRow({}, { entity_fanout: 40, registry_officer_roles: ['manager'] })).tier, TIERS.A)
  assert.equal(evaluateEntityPrincipalMailing(entityRow({ owner_name: 'Linda S Wing Trust' }, {}, { owning_entity_name: 'Linda S Wing Trust' })).tier, TIERS.B)
})

test('owner-of-record: a person on title, a shared distinctive token, or a shared street number', () => {
  assert.equal(entityIsOwnerOfRecord('Banken Holdings LLC', 'German Gonzalez', { given_name: 'German', surname: 'Gonzalez' }).basis, 'person_on_title')
  assert.equal(entityIsOwnerOfRecord('1505 W Juniper LLC', '1505 W Juniper LLC', {}).basis, 'entity_name_match')
  assert.equal(entityIsOwnerOfRecord('Square Nakia', 'Square Nakia', { given_name: 'Tracy', surname: 'Graves' }).hold, 'owner_is_a_different_person')
  assert.equal(entityIsOwnerOfRecord('Properties LLC', 'Holdings LLC', {}).hold, 'entity_not_owner_of_record')
})

test('R4 substitutes a different clean owner-side principal; surname on the name is tier A', () => {
  const row = entityRow({ owner_name: 'Aparicio Revocable Trust', alt_principals: [altPrincipal()] },
    { matching_type: 'property_address', matches_property_owner: false }, { owning_entity_name: 'Aparicio Revocable Trust' })
  const r = evaluateEntityAlternatePrincipal(row)
  assert.equal(r.outcome, 'release')
  assert.equal(r.tier, TIERS.A)
  assert.equal(r.evidence.substitute_phone_last4, '0199')
  const other = evaluateEntityAlternatePrincipal({ ...row, alt_principals: [altPrincipal({ surname: 'Matheis', full_name: 'Erik Matheis', given_name: 'Erik' })] })
  assert.equal(other.tier, TIERS.B)
})

test('R4 rejects DNC, suppressed, unknown-type, renting, occupant and unknown-owner-match candidates', () => {
  const base = entityRow({ owner_name: 'Aparicio Revocable Trust' }, {}, { owning_entity_name: 'Aparicio Revocable Trust' })
  for (const bad of [{ phone_dnc: true }, { phone_dnc: null }, { phone_suppressed: true }, { phone_type: null }, { likely_renting: true },
    { matching_type: 'property_address' }, { matches_property_owner: null }, { individual_key: 'p9' }]) {
    assert.equal(evaluateEntityAlternatePrincipal({ ...base, alt_principals: [altPrincipal(bad)] }).hold, 'no_clean_alternate_principal', JSON.stringify(bad))
  }
})

test('a review-held occupant row is answered by R4; an entity row with no SMS channel too', () => {
  const held = evaluateIdentityHoldShadow(entityRow({ owner_name: 'Aparicio Revocable Trust', alt_principals: [altPrincipal()] },
    { matching_type: 'property_address', matches_property_owner: false }, { owning_entity_name: 'Aparicio Revocable Trust' }))
  assert.equal(held.would_release, true)
  assert.deepEqual(held.rules, [RULES.ENTITY_ALTERNATE_PRINCIPAL])
  const noChannel = evaluateIdentityHoldShadow(entityRow({ queue_eligible: false, queue_block_reason: 'non_sms_capable', owner_name: 'Aparicio Revocable Trust', alt_principals: [altPrincipal()] },
    {}, { owning_entity_name: 'Aparicio Revocable Trust' }))
  assert.equal(noChannel.primary, HOLD_REASONS.ENTITY_NO_SMS_CHANNEL)
  assert.equal(noChannel.would_release, true)
  const suppressed = evaluateIdentityHoldShadow(entityRow({ queue_eligible: false, queue_block_reason: 'suppressed' }))
  assert.equal(suppressed.would_release, false)
  assert.equal(suppressed.hold, 'not_queue_eligible')
})

test('a row is released only when every hold on it is released; summary counts overlap', () => {
  const both = { ...entityRow(), phone_group: { distinct_master_owners: 2, distinct_person_keys: 2, null_person_rows: 0 } }
  const ev = evaluateIdentityHoldShadow(both)
  assert.equal(ev.would_release, false)
  assert.deepEqual(ev.remaining_holds, ['ambiguous_phone_ownership:phone_held_by_multiple_people'])
  const s = summarizeIdentityHoldShadow([ev, evaluateIdentityHoldShadow(entityRow()), evaluateIdentityHoldShadow(linkageRow())])
  assert.equal(s.held, 3)
  assert.equal(s.would_release, 2)
  assert.equal(s.by_overlap['entity_contact_requires_review+ambiguous_phone_ownership'], 1)
  assert.equal(s.released_by_rule[`${RULES.ENTITY_PRINCIPAL_MAILING}:A`], 2)
})
