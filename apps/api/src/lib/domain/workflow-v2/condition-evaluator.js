// Condition evaluator for Workflow Studio V2.
// Evaluates condition nodes against enrollment context and extracted facts.

import { getDefaultSupabaseClient } from '@/lib/supabase/default-client.js';
import { evaluateContactWindow } from '@/lib/supabase/sms-engine.js';
import { getMissingFacts } from '@/lib/domain/workflow-v2/underwriting-playbooks.js';
import { calculateOfferAskGap } from '@/lib/domain/workflow-v2/offer-gap-analysis.js';

function clean(value) {
  return String(value ?? '').trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function asNumber(value, fallback = null) {
  const parsed = Number(String(value ?? '').replace(/[$,]/g, ''));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function db(deps = {}) {
  return deps.supabase ?? deps.supabaseClient ?? getDefaultSupabaseClient();
}

function contextValue(context, key) {
  if (context[key] !== undefined && context[key] !== null && clean(context[key]) !== '') {
    return context[key];
  }
  const extracted = context.extracted_facts ?? {};
  if (extracted[key] !== undefined && extracted[key] !== null) {
    const entry = extracted[key];
    return entry?.value ?? entry?.fact_value?.value ?? entry;
  }
  const underwriting = context.underwriting_facts ?? {};
  if (underwriting[key] !== undefined && underwriting[key] !== null && clean(underwriting[key]) !== '') {
    return underwriting[key];
  }
  return null;
}

function compareEquals(actual, expected) {
  if (expected === undefined || expected === null || expected === '') return Boolean(actual);
  if (Array.isArray(expected)) {
    return expected.map(lower).includes(lower(actual));
  }
  return lower(actual) === lower(expected);
}

function inRange(value, config = {}) {
  const num = asNumber(value);
  if (num === null) return false;
  const min = asNumber(config.min ?? config.gte ?? config.from, null);
  const max = asNumber(config.max ?? config.lte ?? config.to, null);
  if (min !== null && num < min) return false;
  if (max !== null && num > max) return false;
  return true;
}

function conditionResult(result, reason, data = {}) {
  return { result: Boolean(result), reason, data };
}

// ─────────────────────────────────────────────
// Data source: workflow_events (V2-native)
// ─────────────────────────────────────────────

async function hasWorkflowEventReply(subjectId, afterIso, client) {
  const { count, error } = await client
    .from('workflow_events')
    .select('id', { count: 'exact', head: true })
    .eq('subject_id', subjectId)
    .in('event_type', ['seller_replied', 'inbound_message', 'inbound_sms', 'inbound_message_received'])
    .gte('created_at', afterIso);
  if (error) return null;
  return (count ?? 0) > 0;
}

async function hasMessageEventReply(masterOwnerId, afterIso, client) {
  if (!masterOwnerId) return null;
  const { count, error } = await client
    .from('message_events')
    .select('id', { count: 'exact', head: true })
    .eq('master_owner_id', masterOwnerId)
    .eq('direction', 'inbound')
    .gte('created_at', afterIso);
  if (error) return null;
  return (count ?? 0) > 0;
}

async function evaluateSellerReplied({ masterOwnerId, subjectId, enrolledAt, client }) {
  let replied = null;

  if (subjectId) {
    replied = await hasWorkflowEventReply(subjectId, enrolledAt, client);
  }

  if (replied === null && masterOwnerId) {
    replied = await hasMessageEventReply(masterOwnerId, enrolledAt, client);
  }

  if (replied === null) {
    return conditionResult(false, 'no_reply_data_source', {
      master_owner_id: masterOwnerId,
      subject_id: subjectId,
      fallback: true,
    });
  }

  return conditionResult(replied, replied ? 'inbound_message_found' : 'no_inbound_message', {
    master_owner_id: masterOwnerId,
    subject_id: subjectId,
  });
}

async function evaluateNoReplyAfter({ masterOwnerId, subjectId, enrolledAt, config, client }) {
  const amount = Number(config.amount ?? config.hours ?? config.days ?? config.minutes ?? 24);
  const unit = clean(config.unit ?? (config.hours ? 'hours' : config.days ? 'days' : 'hours'));

  const UNIT_MS = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 };
  const ms = (UNIT_MS[unit] ?? 3_600_000) * Math.max(1, amount);
  const deadlineMs = new Date(enrolledAt).getTime() + ms;
  const durationElapsed = Date.now() >= deadlineMs;

  if (!durationElapsed) {
    return conditionResult(false, 'duration_not_yet_elapsed', {
      deadline: new Date(deadlineMs).toISOString(),
    });
  }

  const repliedResult = await evaluateSellerReplied({ masterOwnerId, subjectId, enrolledAt, client });
  const noReply = !repliedResult.result;
  return conditionResult(noReply, noReply ? 'duration_elapsed_no_reply' : 'duration_elapsed_reply_found', {
    deadline: new Date(deadlineMs).toISOString(),
    replied: repliedResult.result,
  });
}

// ─────────────────────────────────────────────
// Context-based condition evaluators
// ─────────────────────────────────────────────

function evaluateAssetClass(context, config) {
  const actual = contextValue(context, 'asset_class') ?? context.asset_class ?? 'single_family';
  const expected = config.value ?? config.asset_class ?? config.expected;
  const result = compareEquals(actual, expected);
  return conditionResult(result, result ? 'asset_class_match' : 'asset_class_mismatch', {
    actual,
    expected,
  });
}

function evaluateCampaign(context, config) {
  const actual = contextValue(context, 'campaign_id') ?? context.campaign_id;
  const expected = config.value ?? config.campaign_id ?? config.campaign;
  const result = compareEquals(actual, expected);
  return conditionResult(result, result ? 'campaign_match' : 'campaign_mismatch', { actual, expected });
}

function evaluateMarket(context, config) {
  const actual = contextValue(context, 'market') ?? context.market;
  const expected = config.value ?? config.market ?? config.expected;
  const result = compareEquals(actual, expected);
  return conditionResult(result, result ? 'market_match' : 'market_mismatch', { actual, expected });
}

function evaluatePipelineStage(context, config) {
  const actual = context.stage ?? context.workflow_stage ?? contextValue(context, 'pipeline_stage');
  const expected = config.value ?? config.stage ?? config.pipeline_stage;
  const result = compareEquals(actual, expected);
  return conditionResult(result, result ? 'pipeline_stage_match' : 'pipeline_stage_mismatch', {
    actual,
    expected,
  });
}

function evaluateSellerIntent(context, config) {
  const actual =
    contextValue(context, 'classification_intent') ??
    context.classification?.primary_intent ??
    contextValue(context, 'seller_interest_level') ??
    context.seller_intent;
  const expected = config.value ?? config.intent ?? config.seller_intent;
  const result = compareEquals(actual, expected);
  return conditionResult(result, result ? 'seller_intent_match' : 'seller_intent_mismatch', {
    actual,
    expected,
  });
}

function evaluateClassificationConfidence(context, config) {
  const confidence = asNumber(
    context.classification?.confidence ?? contextValue(context, 'classification_confidence'),
    0,
  );
  const min = asNumber(config.min ?? config.gte ?? config.threshold, 0);
  const result = confidence >= min;
  return conditionResult(result, result ? 'confidence_above_threshold' : 'confidence_below_threshold', {
    confidence,
    min,
  });
}

function evaluateOwnershipStatus(context, config) {
  const actual = contextValue(context, 'ownership_status');
  const expected = config.value ?? config.ownership_status ?? config.expected;
  const result = compareEquals(actual, expected);
  return conditionResult(result, result ? 'ownership_status_match' : 'ownership_status_mismatch', {
    actual,
    expected,
  });
}

function evaluateDecisionMakerStatus(context, config) {
  const actual = contextValue(context, 'decision_maker_status');
  const expected = config.value ?? config.decision_maker_status ?? config.expected;
  const result = compareEquals(actual, expected);
  return conditionResult(result, result ? 'decision_maker_match' : 'decision_maker_mismatch', {
    actual,
    expected,
  });
}

function evaluateAskingPricePresent(context) {
  const askingPrice = asNumber(
    contextValue(context, 'asking_price') ?? context.asking_price ?? context.seller_asking_price,
  );
  const result = askingPrice !== null && askingPrice > 0;
  return conditionResult(result, result ? 'asking_price_present' : 'asking_price_missing', {
    asking_price: askingPrice,
  });
}

function evaluateOfferToAskRatio(context, config) {
  const gap = calculateOfferAskGap(context);
  const ratio = asNumber(gap.cash_ratio ?? gap.novation_ratio ?? context.offer_to_ask_ratio);
  const result = inRange(ratio, config);
  return conditionResult(result, result ? 'offer_ratio_in_range' : 'offer_ratio_out_of_range', {
    ratio,
    config,
    gap,
  });
}

function evaluateAosRange(context, config) {
  const aos = asNumber(context.aos ?? context.aos_score ?? contextValue(context, 'aos'));
  const result = inRange(aos, config);
  return conditionResult(result, result ? 'aos_in_range' : 'aos_out_of_range', { aos, config });
}

function evaluateBestStrategy(context, config) {
  const actual =
    context.best_strategy ??
    context.acquisition_output?.best_strategy ??
    context.acquisition_engine_output?.best_strategy;
  const expected = config.value ?? config.strategy ?? config.best_strategy;
  const result = compareEquals(actual, expected);
  return conditionResult(result, result ? 'best_strategy_match' : 'best_strategy_mismatch', {
    actual,
    expected,
  });
}

function evaluateMotivationRange(context, config) {
  const score = asNumber(
    context.motivation_score ?? context.seller_motivation_score ?? contextValue(context, 'seller_motivation'),
  );
  const result = inRange(score, config);
  return conditionResult(result, result ? 'motivation_in_range' : 'motivation_out_of_range', { score, config });
}

function evaluateCooperationRange(context, config) {
  const score = asNumber(
    context.seller_cooperation_score ?? context.cooperation_score ?? contextValue(context, 'cooperation_score'),
  );
  const result = inRange(score, config);
  return conditionResult(result, result ? 'cooperation_in_range' : 'cooperation_out_of_range', { score, config });
}

function evaluateMissingUnderwritingFact(context, config) {
  const assetClass = clean(config.asset_class ?? context.asset_class ?? 'single_family');
  const factKey = clean(config.fact_key ?? config.key ?? '');
  const missing = getMissingFacts(assetClass, context);
  const result = factKey ? missing.includes(factKey) : missing.length > 0;
  return conditionResult(result, result ? 'underwriting_fact_missing' : 'underwriting_fact_present', {
    asset_class: assetClass,
    fact_key: factKey || null,
    missing_facts: missing,
  });
}

function evaluateLanguage(context, config) {
  const actual = lower(contextValue(context, 'language') ?? context.contact_language ?? 'en');
  const expected = lower(config.value ?? config.language ?? config.expected ?? 'en');
  const result = actual === expected;
  return conditionResult(result, result ? 'language_match' : 'language_mismatch', { actual, expected });
}

function evaluateMessageDeliveryState(context, config) {
  const actual = lower(
    context.message_delivery_state ?? context.delivery_state ?? context.last_delivery_status ?? '',
  );
  const expected = lower(config.value ?? config.delivery_state ?? config.expected ?? '');
  const result = expected ? actual === expected : Boolean(actual);
  return conditionResult(result, result ? 'delivery_state_match' : 'delivery_state_mismatch', {
    actual,
    expected,
  });
}

function evaluateRetryableFailure(context, config) {
  const deliveryState = lower(context.message_delivery_state ?? context.delivery_state ?? '');
  const retryableStates = ['failed', 'temporary_failure', 'retryable', 'unknown'];
  const expected = config.value ?? config.retryable;
  const result =
    expected === true || expected === 'true'
      ? retryableStates.includes(deliveryState) || context.retryable_failure === true
      : deliveryState === lower(expected);
  return conditionResult(result, result ? 'retryable_failure_detected' : 'not_retryable_failure', {
    delivery_state: deliveryState,
  });
}

function evaluatePriorTouchCount(context, config) {
  const count = Number(context.prior_touch_count ?? context.touch_count ?? 0);
  const operator = clean(config.operator ?? 'gte');
  const threshold = Number(config.count ?? config.value ?? config.threshold ?? 1);
  let result = false;
  if (operator === 'eq') result = count === threshold;
  else if (operator === 'lte') result = count <= threshold;
  else if (operator === 'lt') result = count < threshold;
  else if (operator === 'gt') result = count > threshold;
  else result = count >= threshold;
  return conditionResult(result, result ? 'touch_count_match' : 'touch_count_mismatch', {
    count,
    threshold,
    operator,
  });
}

function evaluateSuppressionState(context, config) {
  const actual = lower(context.suppression_state ?? (context.is_suppressed ? 'suppressed' : 'active'));
  const expected = lower(config.value ?? config.suppression_state ?? 'suppressed');
  const result = actual === expected;
  return conditionResult(result, result ? 'suppression_state_match' : 'suppression_state_mismatch', {
    actual,
    expected,
  });
}

function evaluateContactMethodAvailable(context, config) {
  const method = lower(config.method ?? config.contact_method ?? 'sms');
  const hasSms = Boolean(clean(context.phone ?? context.to_phone ?? ''));
  const hasEmail = Boolean(clean(context.email ?? context.to_email ?? ''));
  const result = method === 'email' ? hasEmail : method === 'any' ? hasSms || hasEmail : hasSms;
  return conditionResult(result, result ? 'contact_method_available' : 'contact_method_unavailable', {
    method,
    has_sms: hasSms,
    has_email: hasEmail,
  });
}

function evaluateContactWindowOpen(context) {
  const windowCheck = evaluateContactWindow({
    timezone: context.timezone ?? context.market_timezone ?? 'America/Chicago',
    contact_window: context.contact_window ?? null,
  });
  return conditionResult(
    windowCheck.allowed,
    windowCheck.allowed ? 'contact_window_open' : windowCheck.reason ?? 'contact_window_closed',
    windowCheck,
  );
}

function evaluateInboundIntent(context, config) {
  const actual = lower(
    context.classification?.primary_intent ??
      contextValue(context, 'classification_intent') ??
      context.inbound_intent ??
      '',
  );
  const expected = lower(config.intent ?? config.value ?? config.expected ?? '');
  const result = expected ? actual === expected : Boolean(actual);
  return conditionResult(result, result ? 'inbound_intent_match' : 'inbound_intent_mismatch', {
    actual,
    expected,
  });
}

// ─────────────────────────────────────────────
// Main evaluator
// ─────────────────────────────────────────────

export async function evaluateConditionNode(node, enrollment, deps = {}) {
  const client = db(deps);
  const nodeType = clean(node.node_type);
  const config = node.config && typeof node.config === 'object' ? node.config : {};
  const context = enrollment.context && typeof enrollment.context === 'object' ? enrollment.context : {};

  const masterOwnerId = clean(context.master_owner_id ?? '') || null;
  const subjectId = clean(context.subject_id ?? enrollment.subject_id ?? '') || null;
  const enrolledAt = enrollment.enrolled_at
    ? new Date(enrollment.enrolled_at).toISOString()
    : new Date(0).toISOString();

  switch (nodeType) {
    case 'condition.seller_replied':
      return evaluateSellerReplied({ masterOwnerId, subjectId, enrolledAt, client });
    case 'condition.no_reply_after':
      return evaluateNoReplyAfter({ masterOwnerId, subjectId, enrolledAt, config, client });
    case 'condition.asset_class':
      return evaluateAssetClass(context, config);
    case 'condition.campaign':
      return evaluateCampaign(context, config);
    case 'condition.market':
      return evaluateMarket(context, config);
    case 'condition.pipeline_stage':
      return evaluatePipelineStage(context, config);
    case 'condition.seller_intent':
      return evaluateSellerIntent(context, config);
    case 'condition.classification_confidence':
      return evaluateClassificationConfidence(context, config);
    case 'condition.ownership_status':
      return evaluateOwnershipStatus(context, config);
    case 'condition.decision_maker_status':
      return evaluateDecisionMakerStatus(context, config);
    case 'condition.asking_price_present':
      return evaluateAskingPricePresent(context);
    case 'condition.offer_to_ask_ratio':
      return evaluateOfferToAskRatio(context, config);
    case 'condition.aos_range':
      return evaluateAosRange(context, config);
    case 'condition.best_strategy':
      return evaluateBestStrategy(context, config);
    case 'condition.motivation_range':
      return evaluateMotivationRange(context, config);
    case 'condition.cooperation_range':
      return evaluateCooperationRange(context, config);
    case 'condition.missing_underwriting_fact':
      return evaluateMissingUnderwritingFact(context, config);
    case 'condition.language':
      return evaluateLanguage(context, config);
    case 'condition.message_delivery_state':
      return evaluateMessageDeliveryState(context, config);
    case 'condition.retryable_failure':
      return evaluateRetryableFailure(context, config);
    case 'condition.prior_touch_count':
      return evaluatePriorTouchCount(context, config);
    case 'condition.suppression_state':
      return evaluateSuppressionState(context, config);
    case 'condition.contact_method_available':
      return evaluateContactMethodAvailable(context, config);
    case 'condition.contact_window_open':
      return evaluateContactWindowOpen(context);
    case 'condition.inbound_intent':
      return evaluateInboundIntent(context, config);
    default:
      return conditionResult(false, `unsupported_condition_type:${nodeType}`, {
        node_type: nodeType,
        evaluated: false,
      });
  }
}