import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCanonicalWorkflowEvent, mapClassificationToSellerIntent, CANONICAL_SELLER_INTENTS } from '@/lib/domain/acquisition/canonical-workflow-event.js';
import {
  claimDualAuthorityProcessing,
  __resetDualAuthorityGuardForTests,
} from '@/lib/domain/acquisition/dual-authority-guard.js';
import { prepareInboundForWorkflowV2, adaptLegacyFlowResult } from '@/lib/domain/acquisition/legacy-seller-flow-adapter.js';
import { evaluateAutoReplyEligibility, requiresHumanReview } from '@/lib/domain/acquisition/auto-reply-policy.js';
import {
  resolveS1FollowUpDelayDays,
  shouldScheduleS1FollowUp,
  S1_MAX_ACTIVE_ATTEMPTS,
} from '@/lib/domain/acquisition/s1-cadence.js';
import {
  normalizeCanonicalUseCase,
  normalizeTemplateDimensions,
} from '@/lib/domain/templates/template-metadata-normalization.js';
import {
  resolveTemplateLifecycleStatus,
  TEMPLATE_LIFECYCLE,
  isTemplateEligibleForSend,
} from '@/lib/domain/templates/template-lifecycle.js';
import { executeAutonomousReply } from '@/lib/domain/seller-flow/execute-autonomous-reply.js';
import { resolveNextNodeByEdge, validateGraph } from '@/lib/domain/workflow-v2/graph-service.js';
import { evaluateConditionNode } from '@/lib/domain/workflow-v2/condition-evaluator.js';
import { buildMasterOrchestratorGraph, buildSystemWorkflowGraph } from '@/lib/domain/workflow-v2/system-workflow-graphs.js';
import { enqueueCanonicalOutboundSms } from '@/lib/domain/queue/canonical-queue-writer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_ROOT = path.resolve(__dirname, '../..');

function node(id, key, kind, type, config = {}) {
  return { id, node_key: key, node_kind: kind, node_type: type, config, is_active: true };
}

function edge(id, src, tgt, condition_key = null, edge_type = 'next') {
  return { id, source_node_id: src, target_node_id: tgt, condition_key, edge_type };
}

function makeSupabase({ existingIdempotency = null, dupBodyCount = 0 } = {}) {
  const chain = {
    select: () => chain,
    insert: () => chain,
    eq: () => chain,
    in: () => chain,
    contains: () => chain,
    gte: () => chain,
    limit: () => chain,
    maybeSingle: () => Promise.resolve({ data: existingIdempotency, error: null }),
    then: (resolve) => resolve({ data: null, error: null, count: dupBodyCount }),
  };
  return { from: () => chain };
}

test('canonical workflow event contract fields', () => {
  const evt = buildCanonicalWorkflowEvent({
    source_event_id: 'evt-1',
    thread_key: '+15551230001',
    master_owner_id: 'mo-1',
    property_id: 'prop-1',
    campaign_id: 'camp-1',
    classification: { primary_intent: 'ownership_confirmed', confidence: 0.92 },
    language: 'English',
    motivation_score: 80,
    urgency_band: 'high',
  });
  assert.equal(evt.source_event_id, 'evt-1');
  assert.equal(evt.master_owner_id, 'mo-1');
  assert.equal(evt.classification_confidence, 0.92);
  assert.ok(evt.idempotency_key.includes('evt-1'));
});

test('dual authority guard blocks second engine on same reply', () => {
  __resetDualAuthorityGuardForTests();
  const first = claimDualAuthorityProcessing({
    source_event_id: 'evt-dup',
    thread_key: 'thread-1',
    engine: 'workflow_v2',
  });
  assert.equal(first.ok, true);
  const second = claimDualAuthorityProcessing({
    source_event_id: 'evt-dup',
    thread_key: 'thread-1',
    engine: 'seller_flow_legacy',
  });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'dual_authority_conflict');
});

test('legacy seller-flow adapter does not authorize send', () => {
  const adapted = adaptLegacyFlowResult(
    { action: 'queue_reply', use_case: 'consider_selling', stage_code: 'S2' },
    buildCanonicalWorkflowEvent({ source_event_id: 'evt-2', thread_key: 't-2' }),
  );
  assert.equal(adapted.authoritative_engine, 'workflow_v2');
  assert.equal(adapted.execute_send, false);
});

test('executeAutonomousReply never imports TextGrid in source', () => {
  const src = fs.readFileSync(
    path.resolve(API_ROOT, 'src/lib/domain/seller-flow/execute-autonomous-reply.js'),
    'utf8',
  );
  assert.equal(src.includes('sendTextgridSMS'), false);
  assert.equal(src.includes('textgrid'), false);
  assert.ok(src.includes('enqueueCanonicalOutboundSms'));
});

test('executeAutonomousReply queues via canonical writer only', async () => {
  let insert_called = false;
  const result = await executeAutonomousReply(
    {
      thread_key: 'T1',
      to_phone_number: '+15005550001',
      from_phone_number: '+15005550002',
      message_body: 'Test body',
      template_id: 'tpl-1',
      source_event_id: 'evt-queue-1',
      stage: 'S1',
    },
    {
      canSendImpl: async () => ({ ok: true }),
      insertQueueImpl: async () => {
        insert_called = true;
        return { queue_row_id: 'q-1' };
      },
      supabase: makeSupabase(),
      getSystemValue: async () => null,
    },
  );
  assert.equal(insert_called, true);
  assert.equal(result.ok, true);
  assert.equal(result.provider_dispatch, 'deferred_to_queue_processor');
});

test('canonical queue writer rejects processing status as immediate send', async () => {
  const result = await enqueueCanonicalOutboundSms(
    {
      thread_key: 'T1',
      to_phone_number: '+15005550001',
      from_phone_number: '+15005550002',
      message_body: 'Hello',
      source_event_id: 'evt-1',
      queue_status: 'processing',
    },
    {
      canSendImpl: async () => ({ ok: true }),
      getSystemValue: async () => null,
      insertQueueImpl: async () => ({ queue_row_id: 'q-bad' }),
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid_queue_status_for_canonical_writer');
});

test('use-case alias asking_price maps to seller_asking_price', () => {
  assert.equal(normalizeCanonicalUseCase('asking_price'), 'seller_asking_price');
  assert.equal(normalizeCanonicalUseCase('seller_asking_price'), 'seller_asking_price');
});

test('template lifecycle: active does not mean auto-reply approved', () => {
  const status = resolveTemplateLifecycleStatus({ is_active: true, safe_for_auto_reply: false });
  assert.equal(status, TEMPLATE_LIFECYCLE.REVIEW_REQUIRED);
  const eligible = isTemplateEligibleForSend({ is_active: true }, { autonomous: true });
  assert.equal(eligible.ok, false);
});

test('auto-reply blocks unsupported language and low confidence', () => {
  const review = requiresHumanReview({ primary_intent: 'unclear', confidence: 0.5 }, { language: 'English' });
  assert.equal(review.required, true);
  const blocked = evaluateAutoReplyEligibility({
    classification: { primary_intent: 'ownership_confirmed', confidence: 0.95, language: 'French' },
    template: { template_body: 'Hi', use_case: 'consider_selling', safe_for_auto_reply: true, is_active: true },
    use_case: 'consider_selling',
    context: { language: 'French' },
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.action, 'human_review');
});

test('S1 cadence: max two active attempts and urgency delays', () => {
  assert.equal(resolveS1FollowUpDelayDays({ urgency_band: 'high' }, 1), 7);
  assert.equal(resolveS1FollowUpDelayDays({ urgency_band: 'medium' }, 1), 14);
  assert.equal(resolveS1FollowUpDelayDays({ urgency_band: 'unknown' }, 1), 21);
  const longTail = shouldScheduleS1FollowUp({ prior_touch_count: S1_MAX_ACTIVE_ATTEMPTS });
  assert.equal(longTail.schedule, 'long_tail_reactivation');
  assert.ok(longTail.delay_days >= 45);
});

test('master orchestrator graph validates with blocked S6 node active', () => {
  const graph = buildMasterOrchestratorGraph();
  const nodes = graph.nodes.map((n, i) => ({ ...n, id: `n-${i}` }));
  const byKey = new Map(nodes.map((n) => [n.node_key, n.id]));
  const edges = graph.edges.map((e, i) => ({
    id: `e-${i}`,
    source_node_id: byKey.get(e.source_node_key),
    target_node_id: byKey.get(e.target_node_key),
    condition_key: e.condition_key,
    edge_type: e.edge_type,
  }));
  const stage6 = nodes.find((n) => n.node_key === 'stage_6');
  assert.equal(stage6.is_active !== false, true);
  assert.equal(stage6.config.blocked, true);
  const validation = validateGraph(nodes, edges);
  assert.equal(validation.ok, true, validation.errors.join(','));
});

test('seller-intent branch routing resolves nuanced intents', async () => {
  const graph = buildSystemWorkflowGraph('interest_qualification');
  const nodes = graph.nodes.map((n, i) => ({ ...n, id: `n-${i}` }));
  const byKey = new Map(nodes.map((n) => [n.node_key, n.id]));
  const edges = graph.edges.map((e, i) => ({
    id: `e-${i}`,
    source_node_id: byKey.get(e.source_node_key),
    target_node_id: byKey.get(e.target_node_key),
    condition_key: e.condition_key,
    edge_type: e.edge_type,
  }));
  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  const branchNode = nodes.find((n) => n.node_key === 'branch_intent');

  const evaluation = await evaluateConditionNode(
    branchNode,
    {
      context: {
        classification: { primary_intent: 'not_interested', confidence: 0.9 },
      },
    },
    {},
  );
  assert.equal(evaluation.branch, CANONICAL_SELLER_INTENTS.NOT_INTERESTED);
  const next = resolveNextNodeByEdge(branchNode.id, evaluation.branch, edges, nodesById);
  assert.equal(next.node_key, 'suppress');
});

test('architectural guard: autonomous reply path has no direct TextGrid provider import', () => {
  const forbidden = [
    'src/lib/domain/seller-flow/execute-autonomous-reply.js',
    'src/lib/domain/seller-flow/autonomous-seller-reply.js',
  ];
  for (const rel of forbidden) {
    const src = fs.readFileSync(path.resolve(API_ROOT, rel), 'utf8');
    assert.equal(/sendTextgridSMS|from\s+["']@\/lib\/providers\/textgrid/.test(src), false, rel);
  }
});

test('S1 template pack preview exists with EN/ES/RU coverage', () => {
  const seedPath = path.resolve(API_ROOT, 'supabase/seeds/acquisition_s1_template_pack.preview.json');
  const pack = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  assert.equal(pack.do_not_apply_to_production, true);
  const langs = new Set(pack.templates.map((t) => t.language));
  assert.ok(langs.has('English'));
  assert.ok(langs.has('Spanish'));
  assert.ok(langs.has('Russian'));
  const t1 = pack.templates.filter((t) => t.use_case === 'ownership_check');
  assert.ok(t1.length >= 3);
});

test('template dimensions normalize stage S1 ownership rows', () => {
  const dims = normalizeTemplateDimensions({
    use_case: 'ownership_check_follow_up',
    language: 'es',
    is_follow_up: true,
  });
  assert.equal(dims.use_case, 'ownership_check_follow_up');
  assert.equal(dims.stage_code, 'S1');
  assert.equal(dims.language, 'Spanish');
  assert.equal(dims.touch_number, 2);
});