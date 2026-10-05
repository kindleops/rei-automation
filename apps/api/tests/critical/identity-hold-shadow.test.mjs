import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  HOLD_REASONS, RULES, TIERS, TAGS, IDENTITY_RELEASE_FLAG,
  isIdentityReleaseEnabled, identityHoldReasons, parseContactMatchingTags,
  evaluateCoOwnerPhoneLink, evaluateSamePersonPhone, evaluateEntityTaggedPrincipal,
  evaluateIdentityRelease, applyIdentityRelease, entityIsOwnerOfRecord, summarizeIdentityRelease,
} from '../../src/lib/domain/campaigns/identity-release.js'
import { evaluateIdentityHoldShadow, evaluateEntityAlternatePrincipal, R4_RULE } from '../../src/lib/domain/campaigns/identity-hold-shadow.js'

const linkage = (over = {}) => ({
  queue_eligible: true,
  canonical_e164: '6125550101',
  seller_person_key: null,
  entity_contact_requires_review: false,
  ambiguous_phone_ownership: false,
  resolution: { status: 'ambiguous', co_owner_individual_key: 'p2', deed_owner_name: 'Saul Cordova', operational_owner_name: 'Saul & Guillermina Cordova' },
  phone_holders: [{ individual_key: 'p2', given_name: 'Guillermina', surname: 'Cordova', full_name: 'Guillermina Cordova', likely_renting: false, tags_on_property: 'Likely Owner, Family' }],
  ...over,
})

const entity = (over = {}, person = {}, ent = {}) => ({
  queue_eligible: true,
  canonical_e164: '6125550102',
  seller_person_key: 'p9',
  owner_name: 'ABC Holdings LLC',
  entity_contact_requires_review: true,
  ambiguous_phone_ownership: false,
  entity: { requires_review: true, exclusion_reasons: ['ENT_ROLE_UNCORROBORATED'], evidence_codes: [], entity_status: 'active', owning_entity_name: 'ABC Holdings, LLC', selected_person_key: 'p9', ...ent },
  person: {
    full_name: 'Jane Smith', given_name: 'Jane', surname: 'Smith', matching_type: 'mailing_address', matches_property_owner: true,
    likely_owner: false, likely_renting: false, in_portfolio: true, phone_is_own: true, entity_fanout: 2, tags_on_property: 'Linked To Company, Family', ...person,
  },
  ...over,
})

test('the live release flag defaults OFF; only explicit values or an explicit option turn it on', () => {
  assert.equal(isIdentityReleaseEnabled({}, {}), false)
  assert.equal(isIdentityReleaseEnabled({}, { [IDENTITY_RELEASE_FLAG]: 'maybe' }), false)
  assert.equal(isIdentityReleaseEnabled({}, { [IDENTITY_RELEASE_FLAG]: 'on' }), true)
  assert.equal(isIdentityReleaseEnabled({ identity_release_enabled: false }, { [IDENTITY_RELEASE_FLAG]: 'on' }), false)
})

test('the predicate is pure: no imports, no I/O', () => {
  const src = fs.readFileSync(new URL('../../src/lib/domain/campaigns/identity-release.js', import.meta.url), 'utf8')
  assert.equal(/^\s*import\s/m.test(src), false)
  assert.equal(/supabase|fetch\(|\.from\(|\.rpc\(/i.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')), false)
})

test('contact matching tags parse with exact spellings only', () => {
  assert.deepEqual(parseContactMatchingTags('Linked To Company, Family,Likely Owner'), ['Linked To Company', 'Family', 'Likely Owner'])
  assert.deepEqual(parseContactMatchingTags('linked to company, Owner-ish'), [])
  assert.deepEqual(parseContactMatchingTags(null), [])
})

test('every identity hold is reported, primary in live precedence order', () => {
  const r = identityHoldReasons({ seller_person_key: null, canonical_e164: '1', entity_contact_requires_review: true, ambiguous_phone_ownership: true })
  assert.deepEqual(r.reasons, [HOLD_REASONS.MISSING_IDENTITY_LINKAGE, HOLD_REASONS.ENTITY_CONTACT_REQUIRES_REVIEW, HOLD_REASONS.AMBIGUOUS_PHONE_OWNERSHIP])
  assert.equal(identityHoldReasons({ seller_person_key: 'p', canonical_e164: '1' }).reasons.length, 0)
})

// ---- Owner's examples -------------------------------------------------------
test('owner example: ABC Holdings LLC + Jane Smith (Linked To Company, own phone, portfolio) → automatic release', () => {
  const ev = evaluateIdentityRelease(entity(), entity())
  assert.equal(ev.released, true)
  assert.equal(ev.tier, TIERS.AUTOMATIC)
  assert.equal(ev.release_rule, RULES.ENTITY_TAGGED_PRINCIPAL)
  assert.deepEqual(ev.evidence[RULES.ENTITY_TAGGED_PRINCIPAL].contact_matching_tags, ['Linked To Company', 'Family'])
})

test('owner example: ABC Holdings LLC + Joe Smith (Resident / Likely Renting) → hold', () => {
  for (const tags of ['Resident', 'Likely Renting', 'Likely Owner, Resident', 'Linked To Company, Likely Renting']) {
    const row = entity({}, { full_name: 'Joe Smith', given_name: 'Joe', tags_on_property: tags })
    const ev = evaluateIdentityRelease(row, row)
    assert.equal(ev.released, false, tags)
    assert.deepEqual(ev.remaining_holds, ['entity_contact_requires_review:resident_or_renter_tag'], tags)
  }
})

test('an occupant is never released, whatever the tag', () => {
  const row = entity({}, { matching_type: 'property_address', matches_property_owner: false, tags_on_property: 'Linked To Company' })
  assert.equal(evaluateEntityTaggedPrincipal(row, row).hold, 'occupant_not_owner')
  assert.equal(evaluateIdentityRelease(row, row).released, false)
  const renter = entity({}, { likely_renting: true, tags_on_property: 'Likely Owner' })
  assert.equal(evaluateEntityTaggedPrincipal(renter, renter).hold, 'renter_not_owner')
})

test('tiers: strong tag + corroboration = automatic; weak tag or no corroboration = review (not released)', () => {
  const likelyOwner = entity({}, { tags_on_property: 'Likely Owner' })
  assert.equal(evaluateIdentityRelease(likelyOwner, likelyOwner).tier, TIERS.AUTOMATIC)
  for (const tags of ['Potentially Linked To Company', 'Potential Owner', 'Family', 'Potentially Linked To Company, Family']) {
    const row = entity({}, { tags_on_property: tags })
    const ev = evaluateIdentityRelease(row, row)
    assert.equal(ev.tier, TIERS.REVIEW, tags)
    assert.equal(ev.released, false, tags)
  }
  const bare = entity({}, { matching_type: 'pi_auto_match', in_portfolio: false, matches_property_owner: null, tags_on_property: 'Linked To Company' })
  assert.equal(evaluateIdentityRelease(bare, bare).tier, TIERS.REVIEW)
  const none = entity({}, { tags_on_property: null })
  assert.equal(evaluateEntityTaggedPrincipal(none, none).hold, 'no_contact_matching_tag')
})

test('unknown never counts: the phone must be the person’s own record', () => {
  for (const v of [null, undefined, false]) {
    const row = entity({}, { phone_is_own: v })
    assert.equal(evaluateEntityTaggedPrincipal(row, row).hold, 'phone_not_persons_own_record')
  }
})

test('institutions, banks, dissolved, agents, placeholders, mis-linked entities and many-entity fronts stay held', () => {
  const cases = [
    [entity({ owner_name: 'First Baptist Church' }, {}, { owning_entity_name: 'First Baptist Church' }), 'institutional_entity'],
    [entity({}, {}, { evidence_codes: ['ENT_BANK_REO'] }), 'bank_reo'],
    [entity({}, {}, { exclusion_reasons: ['ENT_DISSOLVED'] }), 'entity_dissolved'],
    [entity({ owner_name: 'Acme Registered Agent LLC' }, {}, { owning_entity_name: 'Acme Registered Agent LLC' }), 'registered_agent_or_law_firm'],
    [entity({ owner_name: 'Current Owner' }, {}, { owning_entity_name: 'Current Owner' }), 'owner_name_placeholder'],
    [entity({ owner_name: 'Keverry Montrose LLC' }, {}, { owning_entity_name: 'American Youth Hostels, Inc.' }), 'entity_not_owner_of_record'],
    [entity({}, { entity_fanout: 40 }), 'person_fronts_many_entities'],
  ]
  for (const [row, hold] of cases) assert.equal(evaluateEntityTaggedPrincipal(row, row).hold, hold, hold)
})

test('vendor do-not-call does not hold (owner decision) — no DNC input exists in the predicate', () => {
  const row = entity({}, { phone_dnc: true, do_not_call: true })
  assert.equal(evaluateIdentityRelease(row, row).released, true)
  const r1 = linkage({ phone_holders: [{ ...linkage().phone_holders[0], phone_dnc: true }] })
  assert.equal(evaluateIdentityRelease(r1, r1).released, true)
})

test('own suppression, opt-outs, wrong numbers and prior touches always hold (row not queue_eligible)', () => {
  for (const reason of ['suppressed', 'wrong_number', 'pending_prior_touch', 'active_queue_item']) {
    const row = entity({ queue_eligible: false, queue_block_reason: reason })
    const ev = evaluateIdentityRelease(row, row)
    assert.equal(ev.released, false, reason)
    assert.equal(ev.hold, 'not_queue_eligible', reason)
    assert.equal(applyIdentityRelease(row, ev), row, reason)
    assert.equal(evaluateIdentityHoldShadow(row).released, false, reason)
  }
})

test('R1 releases the co-owner on title (ambiguous = automatic, conflicting = review)', () => {
  const ev = evaluateIdentityRelease(linkage(), linkage())
  assert.equal(ev.released, true)
  assert.equal(ev.person_key, 'p2')
  assert.equal(ev.identity_alignment, 'probable')
  const conflicting = linkage({ resolution: { ...linkage().resolution, status: 'conflicting_existing_assignment' } })
  assert.equal(evaluateIdentityRelease(conflicting, conflicting).tier, TIERS.REVIEW)
  assert.equal(evaluateIdentityRelease(conflicting, conflicting).released, false)
})

test('R1 holds: not the co-owner, not on title, shared phone, renting holder, no holder', () => {
  assert.equal(evaluateCoOwnerPhoneLink(linkage({ resolution: { ...linkage().resolution, co_owner_individual_key: 'p3' } })).hold, 'holder_is_not_resolver_co_owner')
  assert.equal(evaluateCoOwnerPhoneLink(linkage({ resolution: { ...linkage().resolution, operational_owner_name: 'Saul Cordova' } })).hold, 'holder_name_not_on_title')
  assert.equal(evaluateCoOwnerPhoneLink(linkage({ phone_holders: [linkage().phone_holders[0], { individual_key: 'p5' }] })).hold, 'phone_shared_by_multiple_linked_people')
  assert.equal(evaluateCoOwnerPhoneLink(linkage({ phone_holders: [{ ...linkage().phone_holders[0], tags_on_property: 'Likely Renting' }] })).hold, 'renter_not_owner')
  assert.equal(evaluateCoOwnerPhoneLink(linkage({ phone_holders: [] })).hold, 'no_property_linked_holder_of_phone')
})

test('R2 releases one canonical person split across legacy owner ids; shared phones hold', () => {
  assert.equal(evaluateSamePersonPhone({ phone_group: { distinct_master_owners: 2, distinct_person_keys: 1, null_person_rows: 0, person_key: 'p1' } }).outcome, 'release')
  assert.equal(evaluateSamePersonPhone({ phone_group: { distinct_master_owners: 2, distinct_person_keys: 2, null_person_rows: 0 } }).hold, 'phone_held_by_multiple_people')
  assert.equal(evaluateSamePersonPhone({ phone_group: { distinct_master_owners: 2, distinct_person_keys: 1, null_person_rows: 1 } }).hold, 'a_row_on_phone_has_no_person')
})

test('a row is released only when EVERY hold on it is released at the automatic tier', () => {
  const both = entity({ ambiguous_phone_ownership: true, phone_group: { distinct_master_owners: 2, distinct_person_keys: 2, null_person_rows: 0 } })
  const ev = evaluateIdentityRelease(both, both)
  assert.equal(ev.released, false)
  assert.deepEqual(ev.remaining_holds, ['ambiguous_phone_ownership:phone_held_by_multiple_people'])
  const ok = entity({ ambiguous_phone_ownership: true, phone_group: { distinct_master_owners: 2, distinct_person_keys: 1, null_person_rows: 0, person_key: 'p9' } })
  assert.equal(evaluateIdentityRelease(ok, ok).release_rule, `${RULES.ENTITY_TAGGED_PRINCIPAL}+${RULES.SAME_PERSON_PHONE}`)
})

test('applyIdentityRelease clears only the released holds and records rule + evidence; non-release is identity', () => {
  const row = entity()
  const released = applyIdentityRelease(row, evaluateIdentityRelease(row, row))
  assert.equal(released.entity_contact_requires_review, false)
  assert.equal(released.identity_alignment, 'entity_company_linked')
  assert.equal(released.identity_release.release_rule, RULES.ENTITY_TAGGED_PRINCIPAL)
  assert.equal(released.queue_eligible, true)
  assert.equal(row.entity_contact_requires_review, true, 'input row not mutated')
  const held = entity({}, { tags_on_property: 'Resident' })
  assert.equal(applyIdentityRelease(held, evaluateIdentityRelease(held, held)), held)
  const linked = applyIdentityRelease(linkage(), evaluateIdentityRelease(linkage(), linkage()))
  assert.equal(linked.seller_person_key, 'p2')
})

test('R4 (substitute principal) never releases — report only', () => {
  const row = entity({ alt_principals: [{ individual_key: 'p7', full_name: 'Amy Smith', given_name: 'Amy', surname: 'Smith', matching_type: 'mailing_address', matches_property_owner: true, likely_renting: false, phone: '2145550199', phone_type: 'W', phone_suppressed: false }] },
    { matching_type: 'property_address', matches_property_owner: false, tags_on_property: 'Resident' })
  const shadow = evaluateIdentityHoldShadow(row)
  assert.equal(shadow.released, false)
  assert.equal(shadow.r4.rule, R4_RULE)
  assert.equal(shadow.r4.outcome, 'would_substitute')
  assert.equal(shadow.r4.not_approved, true)
  const noChannel = evaluateIdentityHoldShadow({ ...row, queue_eligible: false, queue_block_reason: 'non_sms_capable' })
  assert.equal(noChannel.released, false)
  assert.equal(evaluateEntityAlternatePrincipal({ ...row, alt_principals: [] }).outcome, 'hold')
  const src = fs.readFileSync(new URL('../../src/lib/domain/campaigns/identity-release.js', import.meta.url), 'utf8')
  assert.equal(/alt_principals|R4_/.test(src), false, 'the live predicate has no substitute rule')
})

test('owner-of-record bases', () => {
  assert.equal(entityIsOwnerOfRecord('Banken Holdings LLC', 'German Gonzalez', { given_name: 'German', surname: 'Gonzalez' }).basis, 'person_on_title')
  assert.equal(entityIsOwnerOfRecord('1505 W Juniper LLC', '1505 W Juniper LLC', {}).basis, 'entity_name_match')
  assert.equal(entityIsOwnerOfRecord('Square Nakia', 'Square Nakia', { given_name: 'Tracy', surname: 'Graves' }).hold, 'owner_is_a_different_person')
})

test('summary counts held, released, tiers and overlap', () => {
  const rows = [entity(), entity({}, { tags_on_property: 'Family' }), linkage(), entity({}, { tags_on_property: 'Resident' })]
  const s = summarizeIdentityRelease(rows.map((r) => evaluateIdentityRelease(r, r)))
  assert.equal(s.held, 4)
  assert.equal(s.released, 2)
  assert.equal(s.by_tier.review, 1)
  assert.equal(TAGS.LINKED_TO_COMPANY, 'Linked To Company')
})
