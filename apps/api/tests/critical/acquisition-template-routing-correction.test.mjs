import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveCanonicalLanguage,
  canonicalLanguageMatches,
  buildLanguageInventoryFromTemplates,
  __resetCatalogLanguagesForTests,
} from '@/lib/domain/templates/canonical-language-adapter.js';
import {
  resolveTemplateLifecycleStatus,
  TEMPLATE_LIFECYCLE,
  isTemplateEligibleForSend,
} from '@/lib/domain/templates/template-lifecycle.js';
import { resolveTemplateFromPool } from '@/lib/domain/templates/template-runtime-resolver.js';
import {
  evaluateAutoReplyEligibility,
  evaluateClarificationPath,
  requiresOperatorException,
} from '@/lib/domain/acquisition/auto-reply-policy.js';
import {
  buildLogicalActionId,
  classifyOutboundFailure,
  planOutboundRetry,
  selectRetryTemplate,
  MAX_RETRY_ATTEMPTS,
  FAILURE_CLASS,
} from '@/lib/domain/acquisition/outbound-retry-contract.js';
import { normalizeTemplateDimensions } from '@/lib/domain/templates/template-metadata-normalization.js';

const MULTILINGUAL_FIXTURES = [
  { raw: 'pt', canonical: 'Portuguese', iso: 'pt' },
  { raw: 'Hebrew', canonical: 'Hebrew', iso: 'he' },
  { raw: 'ja', canonical: 'Japanese', iso: 'ja' },
  { raw: 'zh-CN', canonical: 'Mandarin', iso: 'zh' },
  { raw: 'it', canonical: 'Italian', iso: 'it' },
  { raw: 'de', canonical: 'German', iso: 'de' },
];

function enabledTemplate(overrides = {}) {
  return {
    id: overrides.id || 'tpl-1',
    template_id: overrides.id || 'tpl-1',
    template_body: overrides.template_body || 'Hi {{seller_first_name}}',
    variables: overrides.variables || ['seller_first_name'],
    use_case: overrides.use_case || 'ownership_check',
    language: overrides.language || 'English',
    stage_code: overrides.stage_code || 'S1',
    is_active: true,
    is_first_touch: true,
    touch_number: overrides.touch_number ?? 1,
    ...overrides,
  };
}

test('lifecycle: enabled templates are automation-eligible', () => {
  const status = resolveTemplateLifecycleStatus({ is_active: true });
  assert.equal(status, TEMPLATE_LIFECYCLE.ENABLED);
  const eligible = isTemplateEligibleForSend({ is_active: true }, { autonomous: true });
  assert.equal(eligible.ok, true);
});

test('lifecycle: draft/disabled/retired never selected', () => {
  assert.equal(isTemplateEligibleForSend({ lifecycle_status: 'draft' }).ok, false);
  assert.equal(isTemplateEligibleForSend({ is_active: false }).ok, false);
  assert.equal(isTemplateEligibleForSend({ metadata: { retired: true }, is_active: true }).ok, false);
});

test('lifecycle: review_required legacy maps to draft not gate', () => {
  const status = resolveTemplateLifecycleStatus({ lifecycle_status: 'review_required', is_active: true });
  assert.equal(status, TEMPLATE_LIFECYCLE.DRAFT);
});

test('lifecycle: approved_for_automatic_reply legacy maps to enabled', () => {
  const status = resolveTemplateLifecycleStatus({ lifecycle_status: 'approved_for_automatic_reply', is_active: true });
  assert.equal(status, TEMPLATE_LIFECYCLE.ENABLED);
  assert.equal(isTemplateEligibleForSend({ lifecycle_status: 'approved_for_automatic_reply', is_active: true }).ok, true);
});

test('language adapter: multilingual ISO normalization', () => {
  __resetCatalogLanguagesForTests();
  for (const fixture of MULTILINGUAL_FIXTURES) {
    const resolved = resolveCanonicalLanguage(fixture.raw);
    assert.equal(resolved.canonical, fixture.canonical, fixture.raw);
    assert.equal(resolved.iso, fixture.iso, fixture.raw);
  }
});

test('language adapter: no silent English fallback', () => {
  const fr = resolveCanonicalLanguage('fr');
  assert.equal(fr.canonical, 'French');
  assert.notEqual(fr.canonical, 'English');
});

test('template resolver: exact stage/language/use-case matching', () => {
  const candidates = [
    enabledTemplate({ id: 'en-s1', language: 'English', use_case: 'ownership_check', stage_code: 'S1' }),
    enabledTemplate({ id: 'pt-s1', language: 'Portuguese', use_case: 'ownership_check', stage_code: 'S1' }),
    enabledTemplate({ id: 'en-s2', language: 'English', use_case: 'consider_selling', stage_code: 'S2' }),
  ];
  const merge_variables = { seller_first_name: 'Ana' };

  const pt = resolveTemplateFromPool(
    { use_case: 'ownership_check', language: 'Portuguese', stage_code: 'S1', merge_variables },
    candidates,
  );
  assert.equal(pt.ok, true);
  assert.equal(pt.template_id, 'pt-s1');

  const de = resolveTemplateFromPool(
    { use_case: 'ownership_check', language: 'German', stage_code: 'S1', merge_variables },
    candidates,
  );
  assert.equal(de.ok, false);
});

test('template resolver: disabled templates excluded', () => {
  const candidates = [
    enabledTemplate({ id: 'disabled', is_active: false }),
    enabledTemplate({ id: 'enabled-2' }),
  ];
  const result = resolveTemplateFromPool(
    { use_case: 'ownership_check', language: 'English', stage_code: 'S1', merge_variables: { seller_first_name: 'X' } },
    candidates,
  );
  assert.equal(result.template_id, 'enabled-2');
});

test('retry: transient failure reuses same template', () => {
  const failure = classifyOutboundFailure({ message: 'connection reset timeout' });
  assert.equal(failure.class, FAILURE_CLASS.TRANSIENT);
  const plan = planOutboundRetry({
    enrollment_id: 'enr-1',
    thread_key: 'thread-1',
    stage: 'S1',
    language: 'Portuguese',
    use_case: 'ownership_check',
    attempt_number: 1,
    failure: { message: 'timeout' },
  });
  assert.equal(plan.retry, true);
  assert.equal(plan.preserve_template, true);
  assert.equal(plan.preserve_language, true);
});

test('retry: content failure rotates within same language/stage', () => {
  const candidates = [
    enabledTemplate({ id: 'a', language: 'Hebrew' }),
    enabledTemplate({ id: 'b', language: 'Hebrew' }),
  ];
  const selected = selectRetryTemplate(
    {
      enrollment_id: 'e1',
      thread_key: 't1',
      stage: 'S1',
      language: 'Hebrew',
      use_case: 'ownership_check',
      attempt_number: 1,
      template_id: 'a',
      failed_template_ids: ['a'],
      failure: { message: 'missing merge variable seller_first_name' },
      merge_variables: { seller_first_name: 'Yosef' },
    },
    candidates,
  );
  assert.equal(selected.ok, true);
  assert.equal(selected.template_id, 'b');
  assert.equal(selected.rotated, true);
});

test('retry: no cross-language rotation', () => {
  const candidates = [
    enabledTemplate({ id: 'he', language: 'Hebrew' }),
    enabledTemplate({ id: 'en', language: 'English' }),
  ];
  const selected = selectRetryTemplate(
    {
      stage: 'S1',
      language: 'Hebrew',
      use_case: 'ownership_check',
      attempt_number: 1,
      failed_template_ids: ['he'],
      failure: { message: 'render failure' },
      merge_variables: { seller_first_name: 'Yosef' },
    },
    candidates,
  );
  assert.equal(selected.ok, false);
});

test('retry: terminal 21610 never retries', () => {
  const plan = planOutboundRetry({ attempt_number: 1, failure: { code: '21610' } });
  assert.equal(plan.terminal, true);
  assert.equal(plan.retry, false);
});

test('retry: max three attempts enforced', () => {
  const plan = planOutboundRetry({ attempt_number: MAX_RETRY_ATTEMPTS, failure: { message: 'timeout' } });
  assert.equal(plan.exhausted, true);
  assert.equal(plan.retry, false);
});

test('retry: logical action id stable across attempts', () => {
  const base = {
    enrollment_id: 'enr-99',
    thread_key: '+15551230001',
    stage: 'S1',
    language: 'Japanese',
    use_case: 'ownership_check',
    logical_action_sequence: '2',
  };
  const id1 = buildLogicalActionId(base);
  const id2 = buildLogicalActionId({ ...base, attempt_number: 2 });
  assert.equal(id1, id2);
});

test('auto-reply: low confidence routes to clarification not human review', () => {
  const path = evaluateClarificationPath(
    { primary_intent: 'unclear', confidence: 0.55, language: 'Italian' },
    { current_stage: 'S1', language: 'Italian', clarification_attempt_count: 0 },
  );
  assert.equal(path.ok, true);
  assert.equal(path.action, 'queue_clarification');
  assert.equal(path.language, 'Italian');
});

test('auto-reply: Portuguese enabled template eligible', () => {
  const result = evaluateAutoReplyEligibility({
    classification: { primary_intent: 'ownership_confirmed', confidence: 0.95, language: 'Portuguese' },
    template: enabledTemplate({ language: 'Portuguese', use_case: 'consider_selling' }),
    use_case: 'consider_selling',
    context: { language: 'Portuguese', merge_variables: { seller_first_name: 'Maria' } },
  });
  assert.equal(result.ok, true);
  assert.equal(result.action, 'queue_auto_reply');
});

test('auto-reply: French no longer blocked by language allowlist', () => {
  const result = evaluateAutoReplyEligibility({
    classification: { primary_intent: 'ownership_confirmed', confidence: 0.95, language: 'French' },
    template: enabledTemplate({ language: 'French', use_case: 'ownership_check' }),
    use_case: 'ownership_check',
    context: { language: 'French', merge_variables: { seller_first_name: 'Marie' } },
  });
  assert.equal(result.ok, true);
});

test('auto-reply: opt-out is terminal suppression not clarification', () => {
  const ex = requiresOperatorException({ compliance_flag: 'opt_out' }, {});
  assert.equal(ex.action, 'terminal_suppression');
});

test('dimensions: es normalizes to Spanish via adapter', () => {
  const dims = normalizeTemplateDimensions({ use_case: 'ownership_check', language: 'es' });
  assert.equal(dims.language, 'Spanish');
  assert.equal(dims.stage_code, 'S1');
});

test('language inventory builder aggregates catalog rows', () => {
  const inventory = buildLanguageInventoryFromTemplates([
    { language: 'Portuguese', is_active: true, stage_code: 'S1', use_case: 'ownership_check', touch_number: 1 },
    { language: 'pt', is_active: false, stage_code: 'S1', use_case: 'ownership_check' },
  ]);
  const pt = inventory.find((e) => e.canonical === 'Portuguese');
  assert.ok(pt);
  assert.equal(pt.template_count, 2);
});

test('canonical language match respects locale when both specify', () => {
  assert.equal(canonicalLanguageMatches('zh-CN', 'zh-CN'), true);
  assert.equal(canonicalLanguageMatches('zh-CN', 'zh-TW'), false);
});