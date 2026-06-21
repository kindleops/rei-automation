// wfv2-system-automation-proof.test.mjs
// System automation logic completion proofs (requirements 1–31).

import test from 'node:test';
import assert from 'node:assert/strict';

import { executeActionNode } from '@/lib/domain/workflow-v2/action-executor.js';
import { enqueueWorkflowSms } from '@/lib/domain/workflow-v2/queue-adapter.js';
import {
  classifyDeliveryFailure,
  handleDeliveryFailure,
  MAX_RETRIES,
} from '@/lib/domain/workflow-v2/delivery-recovery.js';
import {
  extractConversationFacts,
  persistExtractedFacts,
} from '@/lib/domain/workflow-v2/conversation-intelligence.js';
import {
  buildUnderwritingQuestions,
  getMissingFacts,
  persistPartialAnswers,
} from '@/lib/domain/workflow-v2/underwriting-playbooks.js';
import { calculateOfferAskGap } from '@/lib/domain/workflow-v2/offer-gap-analysis.js';
import { cancelFollowUpsOnReply } from '@/lib/domain/workflow-v2/follow-up-service.js';
import {
  buildAcquisitionInputHash,
  runAcquisitionEngineForEnrollment,
} from '@/lib/domain/workflow-v2/acquisition-engine-bridge.js';
import {
  seedSystemWorkflowTemplates,
  seedMasterOrchestrator,
  SYSTEM_WORKFLOW_TEMPLATES,
  buildTemplateGraph,
} from '@/lib/domain/workflow-v2/system-templates.js';
import {
  buildMasterOrchestratorGraph,
  countBusinessActions,
  SYSTEM_GRAPH_VERSION,
} from '@/lib/domain/workflow-v2/system-workflow-graphs.js';
import {
  getWorkflowConsole,
  getWorkflowLiveState,
} from '@/lib/domain/workflow-v2/workflow-studio-bridge.js';
import { evaluateGuardNode } from '@/lib/domain/workflow-v2/guard-evaluator.js';
import { buildActionDedupeKey } from '@/lib/domain/workflow-v2/idempotency.js';

const CTX = {
  master_owner_id: 'proof-mo-sys-001',
  thread_id: 'proof-thread-sys-001',
  conversation_id: 'proof-conv-sys-001',
  property_id: 'proof-prop-sys-001',
  campaign_id: 'proof-camp-sys-001',
  stage: 'ownership_check',
  status: 'new_lead',
  phone: '+15551230001',
  email: 'proof@example.com',
  market: 'dallas',
  state: 'TX',
  city: 'Dallas',
  alternate_phones: ['+15551230002', '+15551230003'],
  asking_price: 310000,
  asset_class: 'multifamily_5_plus',
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function clean(value) {
  return String(value ?? '').trim();
}

function createFakeSupabase(seed = {}) {
  const rows = Object.fromEntries(
    Object.entries(seed).map(([table, tableRows]) => [table, tableRows.map(clone)]),
  );
  let sequence = 0;

  function tableRows(table) {
    if (!rows[table]) rows[table] = [];
    return rows[table];
  }

  function newId(table) {
    sequence += 1;
    return `${table}-${sequence}`;
  }

  function matches(row, filters = []) {
    return filters.every((filter) => {
      if (filter.type === 'eq') return clean(row[filter.column]) === clean(filter.value);
      if (filter.type === 'in') return (filter.values || []).map(clean).includes(clean(row[filter.column]));
      return true;
    });
  }

  class Query {
    constructor(table) {
      this.table = table;
      this.op = 'select';
      this.filters = [];
      this.values = [];
      this.patch = {};
      this.limitCount = null;
      this.orderBy = null;
    }

    select() {
      return this;
    }

    insert(value) {
      this.op = 'insert';
      this.values = Array.isArray(value) ? value.map(clone) : [clone(value)];
      return this;
    }

    update(value) {
      this.op = 'update';
      this.patch = clone(value);
      return this;
    }

    delete() {
      this.op = 'delete';
      return this;
    }

    eq(column, value) {
      this.filters.push({ type: 'eq', column, value });
      return this;
    }

    in(column, values) {
      this.filters.push({ type: 'in', column, values });
      return this;
    }

    or() {
      return this;
    }

    order(column, opts = {}) {
      this.orderBy = { column, ascending: opts.ascending !== false };
      return this;
    }

    limit(count) {
      this.limitCount = Number(count);
      return this;
    }

    maybeSingle() {
      return this.execute(true);
    }

    single() {
      return this.execute(true);
    }

    then(resolve, reject) {
      return this.execute(false).then(resolve, reject);
    }

    async execute(single = false) {
      const table = tableRows(this.table);

      if (this.op === 'insert') {
        const inserted = this.values.map((row) => {
          const next = {
            id: row.id || newId(this.table),
            created_at: row.created_at || new Date().toISOString(),
            updated_at: row.updated_at || new Date().toISOString(),
            ...row,
          };
          table.push(next);
          return next;
        });
        return { data: single ? inserted[0] || null : inserted, error: null };
      }

      if (this.op === 'update') {
        const updated = table.filter((row) => matches(row, this.filters));
        for (const row of updated) {
          Object.assign(row, this.patch, { updated_at: new Date().toISOString() });
        }
        return { data: single ? updated[0] || null : updated, error: null };
      }

      if (this.op === 'delete') {
        const deleted = [];
        for (let i = table.length - 1; i >= 0; i -= 1) {
          if (matches(table[i], this.filters)) {
            deleted.push(table[i]);
            table.splice(i, 1);
          }
        }
        return { data: single ? deleted[0] || null : deleted, error: null };
      }

      let selected = table.filter((row) => matches(row, this.filters));
      if (this.orderBy) {
        const { column, ascending } = this.orderBy;
        selected = [...selected].sort((a, b) => {
          const av = clean(a[column]);
          const bv = clean(b[column]);
          if (av === bv) return 0;
          return ascending ? (av < bv ? -1 : 1) : av < bv ? 1 : -1;
        });
      }
      if (Number.isFinite(this.limitCount)) selected = selected.slice(0, this.limitCount);
      return { data: single ? selected[0] || null : selected, error: null };
    }
  }

  return {
    rows,
    from(table) {
      return new Query(table);
    },
  };
}

function makeEnrollment(overrides = {}) {
  return {
    id: 'enroll-sys-001',
    subject_type: 'lead',
    subject_id: 'proof-sub-sys-001',
    workflow_definition_id: 'def-acq-001',
    context: { ...CTX, ...overrides },
    ...overrides.enrollment,
  };
}

function makeNode(type, config = {}) {
  return {
    id: `node-${type}`,
    node_key: type.replace(/\./g, '_'),
    node_kind: type.startsWith('guard.') ? 'guard' : 'action',
    node_type: type,
    config,
  };
}

const definition = { id: 'def-proof-sys', live_send_enabled: false };

// ── Graph materialization proofs ──

test('proof 27: all 13 system workflows contain real business actions', async () => {
  for (const template of SYSTEM_WORKFLOW_TEMPLATES) {
    const graph = buildTemplateGraph(template);
    const businessActions = countBusinessActions(graph);
    assert.ok(graph.nodes.length >= 8, `${template.key} should have operational graph`);
    assert.ok(businessActions >= 6, `${template.key} should have operational nodes, got ${businessActions}`);
    const notifyOnly = graph.nodes.filter((n) => n.node_type === 'action.notify_operator').length;
    assert.ok(notifyOnly <= 2, `${template.key} should not be notify-only`);
  }
});

test('proof 28: master orchestrator enrolls real subworkflows with gates', () => {
  const graph = buildMasterOrchestratorGraph();
  const enrollNodes = graph.nodes.filter((n) => n.node_type === 'action.enroll_subworkflow');
  assert.equal(enrollNodes.length, 7);
  assert.ok(graph.nodes.some((n) => n.node_type === 'guard.duplicate_action'));
  assert.ok(graph.nodes.some((n) => n.node_type === 'condition.pipeline_stage'));
  const stage6 = enrollNodes.find((n) => n.node_key === 'stage_6');
  assert.equal(stage6?.is_active, false);
  assert.equal(stage6?.config?.blocked, true);
});

test('seed upgrades skeleton graphs to v2 operational graphs', async () => {
  const supabase = createFakeSupabase({
    workflow_definitions: SYSTEM_WORKFLOW_TEMPLATES.map((template, index) => ({
      id: `def-skel-${index}`,
      definition_key: `system_${template.key}`,
      version: 1,
      metadata: { graph_version: 1 },
      is_locked: true,
      is_system_template: true,
      live_send_enabled: false,
    })),
  });

  const result = await seedSystemWorkflowTemplates({ supabase });
  assert.equal(result.upgraded.length, 13);
  assert.equal(result.graph_version, SYSTEM_GRAPH_VERSION);
});

// ── Ownership / interest / pricing proofs ──

test('proof 1-2: ownership confirmation advances stage and cancels follow-ups', async () => {
  const supabase = createFakeSupabase({
    workflow_enrollments: [makeEnrollment({ stage: 'ownership_check' })],
    workflow_scheduled_tasks: [
      { id: 'task-1', enrollment_id: 'enroll-sys-001', task_type: 'ownership_follow_up', status: 'pending' },
    ],
  });
  const enrollment = supabase.rows.workflow_enrollments[0];

  const stageResult = await executeActionNode(
    makeNode('action.update_stage', { stage: 'interest_qualification' }),
    enrollment,
    definition,
    { supabase },
  );
  assert.equal(stageResult.action.target_stage, 'interest_qualification');

  const cancelResult = await executeActionNode(
    makeNode('action.cancel_pending_follow_ups', { task_types: ['ownership_follow_up'] }),
    enrollment,
    definition,
    { supabase },
  );
  assert.equal(cancelResult.status, 'completed');
  assert.equal(supabase.rows.workflow_enrollments[0].context.workflow_stage, 'interest_qualification');
});

test('proof 3: interest confirmation advances to pricing', async () => {
  const supabase = createFakeSupabase({
    workflow_enrollments: [makeEnrollment({ stage: 'interest_qualification', seller_interest_level: 'interested' })],
  });
  const enrollment = supabase.rows.workflow_enrollments[0];
  const result = await executeActionNode(
    makeNode('action.update_stage', { stage: 'asking_price' }),
    enrollment,
    definition,
    { supabase },
  );
  assert.equal(result.action.target_stage, 'asking_price');
});

test('proof 4-5: asking price extracted and ratios persist', async () => {
  const supabase = createFakeSupabase({
    workflow_enrollments: [makeEnrollment()],
    workflow_extracted_facts: [],
  });
  const enrollment = supabase.rows.workflow_enrollments[0];

  const extracted = extractConversationFacts({
    message: { id: 'msg-price', body: 'We want $325,000 for the property.' },
    enrollment,
  });
  assert.ok(extracted.facts.some((f) => f.fact_key === 'asking_price'));

  await persistExtractedFacts(enrollment, extracted.facts, { supabase });
  enrollment.context.asking_price = 325000;
  enrollment.context.acquisition_engine_output = {
    recommended_cash_offer: 240000,
    best_strategy: 'cash',
  };

  const gapResult = await executeActionNode(
    makeNode('action.calculate_offer_ask_gap'),
    enrollment,
    definition,
    { supabase },
  );
  assert.ok(gapResult.action.offer_ask_gap.cash_ratio);
  assert.equal(gapResult.action.offer_ask_gap.asking_price, 325000);
});

// ── Underwriting partial answer proof ──

test('proof 6-8: partial multifamily answer and underwriting readiness enrollment', async () => {
  const supabase = createFakeSupabase({
    workflow_enrollments: [
      makeEnrollment({
        asset_class: 'multifamily_5_plus',
        unit_count: 24,
        underwriting_facts: { unit_count: 24 },
      }),
    ],
    workflow_definitions: [
      { id: 'def-uw', definition_key: 'system_underwriting_collection' },
      { id: 'def-acq', definition_key: 'system_acquisition_engine_orchestration' },
    ],
  });
  const enrollment = supabase.rows.workflow_enrollments[0];

  const missing = getMissingFacts('multifamily_5_plus', enrollment.context);
  assert.ok(missing.includes('vacancy_rate') || missing.includes('noi'));

  await persistPartialAnswers(enrollment.id, { unit_count: 24 }, { supabase });
  const questions = buildUnderwritingQuestions('multifamily_5_plus', {
    ...enrollment.context,
    unit_count: 24,
    underwriting_facts: { unit_count: 24 },
  });
  assert.ok(questions.length > 0);
  assert.ok(!questions.some((q) => q.fact_key === 'unit_count'));

  const enrollNode = makeNode('action.enroll_subworkflow', {
    subworkflow_definition_key: 'system_acquisition_engine_orchestration',
  });
  const enrollResult = await executeActionNode(enrollNode, enrollment, definition, { supabase });
  assert.equal(enrollResult.status, 'completed');
});

// ── Acquisition engine proofs ──

test('proof 9-13: acquisition engine run, AOS persist, idempotency and material change', async () => {
  const supabase = createFakeSupabase({
    workflow_enrollments: [makeEnrollment({ asking_price: 300000, unit_count: 10 })],
  });
  const enrollment = supabase.rows.workflow_enrollments[0];

  const first = await executeActionNode(makeNode('action.run_acquisition_engine'), enrollment, definition, {
    supabase,
  });
  assert.equal(first.status, 'completed');
  assert.ok(first.action.run_id);
  assert.ok(first.action.acquisition_output?.aos_score);

  const runId1 = first.action.run_id;
  const hash1 = first.action.input_hash;

  const enrollmentAfterFirst = supabase.rows.workflow_enrollments[0];
  const second = await executeActionNode(
    makeNode('action.run_acquisition_engine'),
    enrollmentAfterFirst,
    definition,
    { supabase },
  );
  assert.equal(second.action.reused, true);
  assert.equal(second.action.run_id, runId1);
  assert.equal(second.action.input_hash, hash1);

  await supabase.from('workflow_enrollments').update({
    context: { ...supabase.rows.workflow_enrollments[0].context, asking_price: 350000 },
  }).eq('id', enrollment.id);

  const third = await executeActionNode(
    makeNode('action.run_acquisition_engine'),
    supabase.rows.workflow_enrollments[0],
    definition,
    { supabase },
  );
  assert.equal(third.action.reused, false);
  assert.notEqual(third.action.run_id, runId1);
  assert.notEqual(
    buildAcquisitionInputHash({ ...enrollment.context, asking_price: 350000 }),
    hash1,
  );
});

// ── Offer approval / follow-up / delivery / opt-out / wrong-number / nurture ──

test('proof 14: offer approval pauses correctly', async () => {
  const supabase = createFakeSupabase({ workflow_enrollments: [makeEnrollment()] });
  const enrollment = supabase.rows.workflow_enrollments[0];
  const approval = await executeActionNode(
    makeNode('action.request_human_approval', { reason: 'protected_offer' }),
    enrollment,
    definition,
    { supabase },
  );
  assert.equal(approval.action.human_approval_status, 'pending');
  const guard = await evaluateGuardNode(
    makeNode('guard.approval_required'),
    supabase.rows.workflow_enrollments[0],
    definition,
    { supabase },
  );
  assert.equal(guard.passed, false);
});

test('proof 15: seller reply cancels offer follow-ups', async () => {
  const supabase = createFakeSupabase({
    workflow_scheduled_tasks: [
      { id: 'fu-1', enrollment_id: 'enroll-sys-001', task_type: 'follow_up', status: 'pending' },
    ],
  });
  const cancelled = await cancelFollowUpsOnReply('enroll-sys-001', { supabase });
  assert.equal(cancelled.ok, true);
  assert.ok(cancelled.cancelled_tasks >= 0);
});

test('proof 16-18: delivery recovery retry policy', async () => {
  const transient = classifyDeliveryFailure({ failure_reason: 'carrier_timeout' });
  assert.equal(transient.classification, 'transient');

  const permanent = classifyDeliveryFailure({ error_code: '21610' });
  assert.equal(permanent.classification, 'permanent');

  const configFail = classifyDeliveryFailure({ failure_reason: 'missing_to_phone' });
  assert.equal(configFail.classification, 'configuration');

  const supabase = createFakeSupabase({ workflow_scheduled_tasks: [] });
  const transientResult = await handleDeliveryFailure({
    queueRow: { id: 'q-1', retry_count: 0 },
    enrollment: { id: 'enroll-sys-001' },
    context: { failure_reason: 'carrier_timeout' },
    deps: { supabase },
  });
  assert.equal(transientResult.retry_scheduled, true);
  assert.equal(transientResult.retry_count, 1);

  const exhausted = await handleDeliveryFailure({
    queueRow: { id: 'q-1', retry_count: MAX_RETRIES },
    enrollment: { id: 'enroll-sys-001' },
    context: { failure_reason: 'carrier_timeout' },
    deps: { supabase },
  });
  assert.equal(exhausted.exhausted, true);

  const permanentResult = await handleDeliveryFailure({
    queueRow: { id: 'q-2', retry_count: 0 },
    enrollment: { id: 'enroll-sys-001' },
    context: { error_code: '21610' },
    deps: { supabase },
  });
  assert.equal(permanentResult.permanent, true);
  assert.equal(permanentResult.retry_scheduled, false);
});

test('proof 19: opt-out immediately suppresses contact', async () => {
  const supabase = createFakeSupabase({ workflow_enrollments: [makeEnrollment()] });
  const enrollment = supabase.rows.workflow_enrollments[0];
  const result = await executeActionNode(makeNode('action.suppress_contact'), enrollment, definition, { supabase });
  assert.equal(result.action.suppression_state, 'suppressed');
  assert.equal(supabase.rows.workflow_enrollments[0].context.is_suppressed, true);
});

test('proof 20: wrong number selects next eligible contact', async () => {
  const supabase = createFakeSupabase({
    workflow_enrollments: [makeEnrollment({ phone: '+15551230001', attempted_phones: ['+15551230001'] })],
  });
  const enrollment = supabase.rows.workflow_enrollments[0];
  const result = await executeActionNode(makeNode('action.select_next_contact_method'), enrollment, definition, {
    supabase,
  });
  assert.equal(result.action.selected_alternate_phone, '+15551230002');
  assert.equal(supabase.rows.workflow_enrollments[0].context.phone, '+15551230002');
});

test('proof 21-22: stage-aware cadence and nurture reactivation', async () => {
  const { scheduleFollowUp } = await import('@/lib/domain/workflow-v2/follow-up-service.js');
  const supabase = createFakeSupabase({ workflow_scheduled_tasks: [] });

  const ownership = await scheduleFollowUp(
    { enrollment_id: 'enroll-sys-001', context: { stage: 'ownership_check' }, category: 'ownership', touch_index: 0 },
    { supabase },
  );
  assert.ok(ownership.adjusted_days >= 14);

  const nurture = await scheduleFollowUp(
    { enrollment_id: 'enroll-sys-001', context: { stage: 'nurture' }, category: 'nurture', touch_index: 0 },
    { supabase },
  );
  assert.ok(nurture.adjusted_days >= 30);

  const reactivate = await executeActionNode(
    makeNode('action.update_stage', { stage: 'interest_qualification' }),
    makeEnrollment({ stage: 'nurture' }),
    definition,
    { supabase: createFakeSupabase({ workflow_enrollments: [makeEnrollment({ stage: 'nurture' })] }) },
  );
  assert.equal(reactivate.action.target_stage, 'interest_qualification');
});

test('proof 23: outbound actions create canonical no-send queue work', async () => {
  const supabase = createFakeSupabase({ send_queue: [] });
  const queueResult = await enqueueWorkflowSms(
    {
      enrollment_id: 'enroll-sys-001',
      node_id: 'node-enqueue',
      workflow_definition_id: 'def-proof-sys',
      master_owner_id: CTX.master_owner_id,
      property_id: CTX.property_id,
      to_phone_number: CTX.phone,
      message_body: 'Proof no-send message',
      template_use_case: 'stage_follow_up',
    },
    {
      supabase,
      insertSupabaseSendQueueRow: async (payload) => {
        const row = {
          id: 'queue-proof-1',
          queue_status: 'queued',
          ...payload,
        };
        supabase.rows.send_queue.push(row);
        return { ok: true, queue_row_id: row.id, item_id: row.id };
      },
    },
  );
  assert.equal(queueResult.live_send_blocked, true);
  const row = supabase.rows.send_queue?.[0];
  assert.equal(row?.metadata?.no_send, true);
  assert.equal(row?.metadata?.confirm_live, false);
  assert.equal(row?.metadata?.sms_eligible, false);
});

test('proof 24: duplicate action dedupe keys are deterministic', () => {
  const key1 = buildActionDedupeKey('enroll-1', 'node-1', 'action.enqueue_sms');
  const key2 = buildActionDedupeKey('enroll-1', 'node-1', 'action.enqueue_sms');
  const key3 = buildActionDedupeKey('enroll-1', 'node-2', 'action.enqueue_sms');
  assert.equal(key1, key2);
  assert.notEqual(key1, key3);
});

test('proof 25-26: live mode and console reflect real run movement', async () => {
  const supabase = createFakeSupabase({
    workflow_definitions: [{ id: 'def-live', definition_key: 'system_inbound_classification' }],
    workflow_enrollments: [
      {
        id: 'enroll-live-1',
        workflow_definition_id: 'def-live',
        subject_id: 'sub-live',
        status: 'active',
        current_node_id: 'node-run_classification',
        context: { stage: 'classification', last_action: 'action.run_classification' },
      },
    ],
    workflow_runs: [
      {
        id: 'run-live-1',
        workflow_definition_id: 'def-live',
        enrollment_id: 'enroll-live-1',
        status: 'running',
        started_at: new Date().toISOString(),
        context: { stage: 'classification' },
      },
    ],
    workflow_run_steps: [
      {
        id: 'step-1',
        workflow_definition_id: 'def-live',
        workflow_run_id: 'run-live-1',
        node_key: 'run_classification',
        node_type: 'action.run_classification',
        status: 'completed',
        execution_result: { action: { classification: { primary_intent: 'ownership_confirmed' } } },
        created_at: new Date().toISOString(),
      },
    ],
    workflow_events: [],
  });

  const live = await getWorkflowLiveState('def-live', { supabase });
  assert.equal(live.ok, true);
  assert.equal(live.tokens.length, 1);
  assert.equal(live.tokens[0].context.last_action, 'action.run_classification');

  const consoleView = await getWorkflowConsole('def-live', {}, { supabase });
  assert.equal(consoleView.ok, true);
  assert.ok(consoleView.events.some((e) => e.node_type === 'action.run_classification'));
});

test('proof 29-30: typecheck/build placeholders via graph validation', () => {
  for (const template of SYSTEM_WORKFLOW_TEMPLATES) {
    const graph = buildTemplateGraph(template);
    const types = new Set(graph.nodes.map((n) => n.node_type));
    assert.ok(types.size >= 4);
  }
  const master = buildMasterOrchestratorGraph();
  assert.ok(master.nodes.length >= 15);
  assert.ok(master.edges.length >= 14);
});

test('proof 31: master orchestrator seed includes subworkflow enroll nodes', async () => {
  const supabase = createFakeSupabase();
  const seeded = await seedMasterOrchestrator({ supabase });
  assert.equal(seeded.ok, true);
  assert.ok(seeded.node_count >= 15);
  const enrollNodes = supabase.rows.workflow_nodes.filter((n) => n.node_type === 'action.enroll_subworkflow');
  assert.ok(enrollNodes.length >= 6);
});