import test from 'node:test'
import assert from 'node:assert/strict'

import evaluateVariantFallback, {
  MAX_VARIANT_ATTEMPTS,
  isContentFilterFailure,
  describeFallbackDecision,
} from '@/lib/domain/messaging/template-fallback-authority.js'

import selectVariant, {
  isEligibleVariant,
  wilsonLowerBound,
  buildVariantGroupKey,
} from '@/lib/domain/messaging/adaptive-template-selection.js'

/** A minimal approved template. */
const tpl = (over = {}) => ({
  template_id: 't1',
  template_body: 'Hi {{seller_first_name}}, {{agent_name}} here about {{property_address}}.',
  is_active: true,
  quarantine_state: 'active',
  stage_code: 'S3',
  use_case: 'asking_price_followup',
  language: 'English',
  safe_for_auto_reply: true,
  minimal_fallback: false,
  allowed_property_groups: null,
  prohibited_property_groups: [],
  ...over,
})

const ctx = (over = {}) => ({
  stage_code: 'S3',
  use_case: 'asking_price_followup',
  language: 'English',
  variables: { seller_first_name: 'Cynthia', agent_name: 'Andre', property_address: '5755 Stonewall Tell Rd' },
  attempted_template_ids: [],
  ...over,
})

const contentFilter = {
  failure_class: 'content_filter_blocked',
  normalized_reason: 'blocked_by_textgrid_content_filter',
  retry_allowed: false,
  is_terminal: true,
}

// ── A. content filter selects a DIFFERENT template ────────────────────────
test('A. a content-filter failure permits a different approved variant', () => {
  const decision = evaluateVariantFallback({
    failure: contentFilter,
    attemptsSoFar: 1,
    alreadySucceeded: false,
    remainingCandidates: 4,
  })
  assert.equal(decision.allowed, true)
  assert.equal(decision.next_attempt_number, 2)

  const chosen = selectVariant(
    [tpl({ template_id: 'A' }), tpl({ template_id: 'B' })],
    ctx({ attempted_template_ids: ['A'], variant_attempt_number: 2 }),
  )
  assert.equal(chosen.ok, true)
  assert.equal(chosen.template.template_id, 'B', 'must not reselect the filtered body')
})

// ── B. the same body is never retried ─────────────────────────────────────
test('B. the same body cannot be retried, and retry_allowed keeps its meaning', () => {
  const verdict = isEligibleVariant(tpl({ template_id: 'A' }), ctx({ attempted_template_ids: ['A'] }))
  assert.equal(verdict.eligible, false)
  assert.equal(verdict.reason, 'already_attempted_in_this_communication')

  // §5: same-body retry stays denied; alternate-variant is a SEPARATE permission.
  const described = describeFallbackDecision(
    contentFilter,
    evaluateVariantFallback({ failure: contentFilter, attemptsSoFar: 1, remainingCandidates: 2 }),
  )
  assert.equal(described.retry_allowed, false, 'existing same-body semantic must not weaken')
  assert.equal(described.alternate_variant_allowed, true)
})

// ── C. success on attempt 2 stops the chain ───────────────────────────────
test('C. once a variant succeeds, attempts 3-8 never happen', () => {
  const decision = evaluateVariantFallback({
    failure: contentFilter,
    attemptsSoFar: 2,
    alreadySucceeded: true,
    remainingCandidates: 6,
  })
  assert.equal(decision.allowed, false)
  assert.equal(decision.reason, 'logical_communication_already_succeeded')
})

// ── D. exhaustion stops cleanly at the bound ──────────────────────────────
test('D. the chain stops cleanly after the maximum attempts', () => {
  assert.equal(MAX_VARIANT_ATTEMPTS, 8)
  const decision = evaluateVariantFallback({
    failure: contentFilter,
    attemptsSoFar: 8,
    remainingCandidates: 12,
  })
  assert.equal(decision.allowed, false)
  assert.equal(decision.reason, 'variant_attempts_exhausted')

  // The 8th is permitted; the 9th is not.
  assert.equal(
    evaluateVariantFallback({ failure: contentFilter, attemptsSoFar: 7, remainingCandidates: 3 }).next_attempt_number,
    8,
  )
})

// ── E..H. non-content failures get ZERO fallback ──────────────────────────
for (const [label, failure] of [
  ['E. DNC / opt-out', { failure_class: 'recipient_opted_out', normalized_reason: 'recipient_opted_out' }],
  ['F. sender health', { failure_class: 'sender_health_block', normalized_reason: 'blocked_sender_number' }],
  ['G. quiet hours', { failure_class: null, normalized_reason: 'outside_contact_window' }],
  ['H. invalid destination', { failure_class: 'invalid_to_number', normalized_reason: 'invalid_to_number' }],
]) {
  test(`${label} produces no variant fallback`, () => {
    assert.equal(isContentFilterFailure(failure), false)
    const decision = evaluateVariantFallback({ failure, attemptsSoFar: 1, remainingCandidates: 7 })
    assert.equal(decision.allowed, false)
    assert.equal(decision.reason, 'failure_class_not_content_filter')
  })
}

test('E2. an unclassified failure fails CLOSED', () => {
  for (const failure of [null, {}, { failure_class: 'unknown_failure' }, { normalized_reason: 'content_too_long' }]) {
    assert.equal(
      evaluateVariantFallback({ failure, attemptsSoFar: 1, remainingCandidates: 5 }).allowed,
      false,
      `${JSON.stringify(failure)} must not authorise a reword`,
    )
  }
})

// ── I. stage isolation ────────────────────────────────────────────────────
test('I. an S3 communication cannot fall back to an S1 template', () => {
  const verdict = isEligibleVariant(tpl({ template_id: 'S1x', stage_code: 'S1', use_case: 'ownership_check' }), ctx())
  assert.equal(verdict.eligible, false)
  assert.equal(verdict.reason, 'stage_mismatch')

  // Even when the S1 body is the best performer in the estate.
  const chosen = selectVariant(
    [tpl({ template_id: 'S1x', stage_code: 'S1' }), tpl({ template_id: 'S3ok' })],
    ctx(),
    { performanceByTemplateId: { S1x: { attempts: 500, delivered: 500, content_filtered: 0 } } },
  )
  assert.equal(chosen.template.template_id, 'S3ok', 'performance must not buy past hard eligibility')
})

// ── J. language isolation ─────────────────────────────────────────────────
test('J. an English communication never silently selects Spanish', () => {
  const chosen = selectVariant(
    [tpl({ template_id: 'es', language: 'Spanish' }), tpl({ template_id: 'en' })],
    ctx({ language: 'English' }),
    { performanceByTemplateId: { es: { attempts: 400, delivered: 400, content_filtered: 0 } } },
  )
  assert.equal(chosen.template.template_id, 'en')
})

// ── K. multifamily context compatibility ──────────────────────────────────
test('K. multifamily context respects property-group compatibility', () => {
  const sfrOnly = tpl({ template_id: 'sfr', allowed_property_groups: ['single_family'] })
  const mfOk = tpl({ template_id: 'mf', allowed_property_groups: ['multifamily'] })
  const banned = tpl({ template_id: 'banned', prohibited_property_groups: ['multifamily'] })

  const context = ctx({ property_group: 'multifamily' })
  assert.equal(isEligibleVariant(sfrOnly, context).reason, 'property_group_not_allowed')
  assert.equal(isEligibleVariant(banned, context).reason, 'property_group_prohibited')
  assert.equal(isEligibleVariant(mfOk, context).eligible, true)
})

// ── L. one logical communication, one seller message ──────────────────────
test('L. a successful chain refuses every further variant', () => {
  let succeeded = false
  const attempted = []
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const decision = evaluateVariantFallback({
      failure: contentFilter,
      attemptsSoFar: attempt,
      alreadySucceeded: succeeded,
      remainingCandidates: 8 - attempt,
    })
    if (!decision.allowed) break
    attempted.push(attempt + 1)
    if (attempt === 2) succeeded = true // attempt 3 delivers
  }
  assert.deepEqual(attempted, [2, 3], 'stops the moment a variant succeeds')
})

// ── M. duplicate provider callback cannot spawn a second fallback ─────────
test('M. a duplicate callback for the same failed attempt cannot double-fallback', () => {
  // Both callbacks observe the SAME attemptsSoFar, so both propose attempt 2.
  const first = evaluateVariantFallback({ failure: contentFilter, attemptsSoFar: 1, remainingCandidates: 5 })
  const second = evaluateVariantFallback({ failure: contentFilter, attemptsSoFar: 1, remainingCandidates: 5 })
  assert.equal(first.next_attempt_number, 2)
  assert.equal(second.next_attempt_number, 2)
  // They collide on one slot, which the unique index
  // (logical_communication_id, template_id) refuses at the database. The
  // authority layer is deliberately NOT the thing that makes this safe.
  assert.equal(first.next_attempt_number, second.next_attempt_number)
})

// ── N. a delayed callback after success cannot reopen the chain ───────────
test('N. a late failure callback arriving after success cannot reopen the chain', () => {
  const decision = evaluateVariantFallback({
    failure: contentFilter,
    attemptsSoFar: 1,
    alreadySucceeded: true,
    remainingCandidates: 7,
  })
  assert.equal(decision.allowed, false)
  assert.equal(decision.reason, 'logical_communication_already_succeeded')
})

// ── O. ranking prefers meaningful evidence ────────────────────────────────
test('O. a 1/1 template does not outrank a proven one', () => {
  const chosen = selectVariant([tpl({ template_id: 'lucky' }), tpl({ template_id: 'proven' })], ctx(), {
    performanceByTemplateId: {
      lucky: { attempts: 1, delivered: 1, content_filtered: 0 },
      proven: { attempts: 138, delivered: 129, content_filtered: 0 },
    },
  })
  assert.equal(chosen.template.template_id, 'proven')
  assert.ok(wilsonLowerBound(1, 1) < wilsonLowerBound(129, 138))
})

test('O2. a heavily content-filtered template loses to a clean one', () => {
  // The real FUS2 vs S1 numbers measured in production.
  const chosen = selectVariant([tpl({ template_id: 'fus2' }), tpl({ template_id: 'clean' })], ctx(), {
    performanceByTemplateId: {
      fus2: { attempts: 28, delivered: 4, content_filtered: 24 },
      clean: { attempts: 138, delivered: 129, content_filtered: 0 },
    },
  })
  assert.equal(chosen.template.template_id, 'clean')
})

test('O3. recent filtering demotes a historically good template', () => {
  const lifetimeGood = { attempts: 200, delivered: 190, content_filtered: 5, attempts_7d: 40, content_filter_rate_7d: 0.9 }
  const steady = { attempts: 200, delivered: 180, content_filtered: 10, attempts_7d: 40, content_filter_rate_7d: 0.02 }
  const chosen = selectVariant([tpl({ template_id: 'degrading' }), tpl({ template_id: 'steady' })], ctx(), {
    performanceByTemplateId: { degrading: lifetimeGood, steady },
  })
  assert.equal(chosen.template.template_id, 'steady')
})

// ── P. quarantined templates are unselectable ─────────────────────────────
test('P. a quarantined template can never be selected', () => {
  const chosen = selectVariant(
    [tpl({ template_id: 'q', quarantine_state: 'quarantined' }), tpl({ template_id: 'ok' })],
    ctx(),
    { performanceByTemplateId: { q: { attempts: 900, delivered: 900, content_filtered: 0 } } },
  )
  assert.equal(chosen.template.template_id, 'ok')
  assert.equal(isEligibleVariant(tpl({ quarantine_state: 'quarantined' }), ctx()).reason, 'quarantined')
})

// ── CYNTHIA (§18) ─────────────────────────────────────────────────────────
test('CYNTHIA: variant A content-filtered, variant B delivers, chain stops at 2', () => {
  const variantA = tpl({
    template_id: 'cyn-a',
    template_body: "Hey {{seller_first_name}}, this is {{agent_name}} circling back on {{property_address}}. Open to discussing a number for it?",
  })
  const variantB = tpl({
    template_id: 'cyn-b',
    template_body: "Hey {{seller_first_name}}, this is {{agent_name}} circling back on {{property_address}}. Open to discussing a proposal?",
  })
  const context = ctx({ variables: { seller_first_name: 'Cynthia', agent_name: 'Andre', property_address: '5755 Stonewall Tell Rd' } })

  // Attempt 1 -> A.
  const first = selectVariant([variantA, variantB], { ...context, variant_attempt_number: 1 }, {
    performanceByTemplateId: { 'cyn-a': { attempts: 30, delivered: 25, content_filtered: 2 } },
  })
  assert.equal(first.template.template_id, 'cyn-a')

  // A is content-filtered -> fallback authorised.
  const decision = evaluateVariantFallback({ failure: contentFilter, attemptsSoFar: 1, remainingCandidates: 1 })
  assert.equal(decision.allowed, true)
  assert.equal(decision.next_attempt_number, 2)

  // Attempt 2 -> B, a DIFFERENT body, same stage/intent/language.
  const second = selectVariant(
    [variantA, variantB],
    { ...context, attempted_template_ids: ['cyn-a'], variant_attempt_number: 2, previous_failure_class: 'content_filter_blocked' },
  )
  assert.equal(second.template.template_id, 'cyn-b')
  assert.notEqual(second.template.template_body, variantA.template_body)
  assert.equal(second.template.stage_code, variantA.stage_code)
  assert.equal(second.template.use_case, variantA.use_case)
  assert.equal(second.template.language, variantA.language)
  assert.match(second.selection_reason, /attempt=2/)
  assert.match(second.selection_reason, /previous_failure=content_filter_blocked/)

  // B delivers -> no attempt 3.
  const third = evaluateVariantFallback({
    failure: contentFilter, attemptsSoFar: 2, alreadySucceeded: true, remainingCandidates: 0,
  })
  assert.equal(third.allowed, false)
})

// ── KALEAB (§18) ──────────────────────────────────────────────────────────
test('KALEAB: four filtered candidates then a concise one delivers, each body unique', () => {
  const bodies = [
    'What is the best price you can do if we can close in 7 days as-is?',
    'What is the best number you can do if we can close in 7 days as-is?',
    'What is the best price you can do if we can close in 7 days?',
    'What is your best number if we can close in 7 days?',
    'What is your best number on it?',
  ]
  const candidates = bodies.map((body, i) =>
    tpl({ template_id: `kal-${i + 1}`, template_body: body, minimal_fallback: i === bodies.length - 1 }),
  )

  const attempted = []
  let succeeded = false
  const context = ctx({ variables: {} })

  for (let attempt = 1; attempt <= 8 && !succeeded; attempt += 1) {
    const pick = selectVariant(candidates, {
      ...context,
      attempted_template_ids: [...attempted],
      variant_attempt_number: attempt,
    })
    if (!pick.ok) break
    attempted.push(pick.template.template_id)

    // The concise minimal fallback is the one that delivers.
    if (pick.template.template_body === 'What is your best number on it?') {
      succeeded = true
      break
    }
    const decision = evaluateVariantFallback({
      failure: contentFilter,
      attemptsSoFar: attempt,
      alreadySucceeded: false,
      remainingCandidates: candidates.length - attempted.length,
    })
    if (!decision.allowed) break
  }

  assert.equal(succeeded, true, 'the concise approved variant eventually delivers')
  assert.equal(new Set(attempted).size, attempted.length, 'every body attempted exactly once')
  assert.ok(attempted.length <= MAX_VARIANT_ATTEMPTS)
  // The minimal fallback is held to last.
  assert.equal(attempted[attempted.length - 1], 'kal-5')
  // Intent and stage never drift across the chain.
  for (const id of attempted) {
    const used = candidates.find((c) => c.template_id === id)
    assert.equal(used.stage_code, 'S3')
    assert.equal(used.use_case, 'asking_price_followup')
  }
})

// ── grouping ──────────────────────────────────────────────────────────────
test('variant group key matches the generated column definition', () => {
  assert.equal(
    buildVariantGroupKey({ stage_code: 'S3', use_case: 'asking_price_followup', language: 'English' }),
    'S3|asking_price_followup|English|any',
  )
  assert.equal(buildVariantGroupKey({}), 'nostage|nouse|nolang|any')
})

test('an empty group is reported as an inventory gap, not a delivery failure', () => {
  const decision = evaluateVariantFallback({ failure: contentFilter, attemptsSoFar: 1, remainingCandidates: 0 })
  assert.equal(decision.allowed, false)
  assert.equal(decision.reason, 'no_remaining_approved_variants')
})
