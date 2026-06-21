// wfv2-runtime-proof.test.mjs
//
// Comprehensive Workflow Studio V2 runtime proof (requirements 1–20).
// Uses in-memory fake Supabase — no real DB required.
//
// Run: npm run proof:wfv2-runtime

import test from "node:test";
import assert from "node:assert/strict";

import { ingestWorkflowEvent } from "@/lib/domain/workflow-v2/events-service.js";
import { processEvent } from "@/lib/domain/workflow-v2/execution-service.js";
import { enrollSubject } from "@/lib/domain/workflow-v2/enrollment-service.js";
import { runEnrollment } from "@/lib/domain/workflow-v2/workflow-runner.js";
import { executeActionNode } from "@/lib/domain/workflow-v2/action-executor.js";
import { calculateNextExecutionAt } from "@/lib/domain/workflow-v2/timing-service.js";
import { evaluateConditionNode } from "@/lib/domain/workflow-v2/condition-evaluator.js";
import { enqueueWorkflowSms } from "@/lib/domain/workflow-v2/queue-adapter.js";
import { cancelFollowUpsOnReply } from "@/lib/domain/workflow-v2/follow-up-service.js";
import {
  classifyDeliveryFailure,
  handleDeliveryFailure,
  MAX_RETRIES,
} from "@/lib/domain/workflow-v2/delivery-recovery.js";
import {
  extractConversationFacts,
  persistExtractedFacts,
} from "@/lib/domain/workflow-v2/conversation-intelligence.js";
import { calculateOfferAskGap } from "@/lib/domain/workflow-v2/offer-gap-analysis.js";
import {
  buildUnderwritingQuestions,
  getMissingFacts,
  persistPartialAnswers,
} from "@/lib/domain/workflow-v2/underwriting-playbooks.js";
import {
  calculateSellerCooperation,
  persistCooperationScore,
} from "@/lib/domain/workflow-v2/cooperation-score.js";
import { evaluateGuardNode } from "@/lib/domain/workflow-v2/guard-evaluator.js";
import {
  pauseEnrollment,
  resumeEnrollment,
  getRunHistory,
} from "@/lib/domain/workflow-v2/run-control.js";

// ─────────────────────────────────────────────
// Canonical synthetic context
// ─────────────────────────────────────────────

const CTX = {
  master_owner_id: "proof-mo-001",
  thread_id: "proof-thread-001",
  conversation_id: "proof-conv-001",
  property_id: "proof-prop-001",
  campaign_id: "proof-camp-001",
  stage: "ownership_check",
  status: "new_lead",
  phone: "+15551230001",
  email: "proof@example.com",
  market: "dallas",
  state: "TX",
  city: "Dallas",
  subject_id: "proof-sub-001",
  from_phone_number: "+15559876543",
};

const DEF_ID = "def-proof-001";
const SUBJECT_ID = "proof-sub-001";
const ENROLL_ID = "enroll-proof-001";

// ─────────────────────────────────────────────
// In-memory fake Supabase (stateful)
// ─────────────────────────────────────────────

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function clean(value) {
  return String(value ?? "").trim();
}

function nestedValue(row, column) {
  if (!column.includes("->>")) return row[column];
  const [root, leaf] = column.split("->>");
  const container = row[clean(root)];
  if (!container || typeof container !== "object") return undefined;
  return container[clean(leaf)];
}

function parseOrFilter(filterString = "") {
  const parts = filterString.split(",").map((part) => part.trim()).filter(Boolean);
  return parts.map((part) => {
    if (part.startsWith("and(") && part.endsWith(")")) {
      const inner = part.slice(4, -1);
      const [col, op, val] = inner.split(".");
      return { type: "and", conditions: [{ column: col, op, value: val }] };
    }
    const [col, op, val] = part.split(".");
    return { type: "simple", column: col, op, value: val };
  });
}

function matchesOr(row, orFilter) {
  const clauses = parseOrFilter(orFilter);
  return clauses.some((clause) => {
    if (clause.type === "and") {
      return clause.conditions.every((cond) => matchesComparator(row, cond.column, cond.op, cond.value));
    }
    return matchesComparator(row, clause.column, clause.op, clause.value);
  });
}

function matchesComparator(row, column, op, value) {
  const cell = column.includes("->>") ? nestedValue(row, column) : row[column];
  const left = clean(cell);
  const right = clean(value);
  if (op === "eq") return left === right;
  if (op === "lte") return left <= right;
  if (op === "gte") return left >= right;
  return true;
}

function createFakeSupabase(seed = {}, options = {}) {
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
      if (filter.type === "eq") {
        const column = filter.column;
        const value = filter.value;
        if (column.includes("->>")) {
          return clean(nestedValue(row, column)) === clean(value);
        }
        return clean(row[column]) === clean(value);
      }
      if (filter.type === "in") {
        const values = (filter.values || []).map(clean);
        return values.includes(clean(row[filter.column]));
      }
      if (filter.type === "gte") {
        return clean(row[filter.column]) >= clean(filter.value);
      }
      if (filter.type === "lte") {
        return clean(row[filter.column]) <= clean(filter.value);
      }
      if (filter.type === "or") {
        return matchesOr(row, filter.value);
      }
      return true;
    });
  }

  function findDuplicate(table, row, keys = []) {
    const uniqueKeys = keys.length ? keys : ["dedupe_key", "queue_key"];
    return table.find((candidate) =>
      uniqueKeys.some((key) => {
        const a = clean(candidate[key]);
        const b = clean(row[key]);
        return a && b && a === b;
      }),
    );
  }

  class Query {
    constructor(table) {
      this.table = table;
      this.op = "select";
      this.filters = [];
      this.values = [];
      this.patch = {};
      this.conflictKeys = [];
      this.limitCount = null;
      this.orderBy = null;
      this.countMode = false;
      this.headMode = false;
    }

    select(_columns, opts = {}) {
      this.countMode = opts.count === "exact";
      this.headMode = opts.head === true;
      return this;
    }

    insert(value) {
      this.op = "insert";
      this.values = Array.isArray(value) ? value.map(clone) : [clone(value)];
      return this;
    }

    update(value) {
      this.op = "update";
      this.patch = clone(value);
      return this;
    }

    eq(column, value) {
      this.filters.push({ type: "eq", column, value });
      return this;
    }

    in(column, values) {
      this.filters.push({ type: "in", column, values });
      return this;
    }

    gte(column, value) {
      this.filters.push({ type: "gte", column, value });
      return this;
    }

    lte(column, value) {
      this.filters.push({ type: "lte", column, value });
      return this;
    }

    or(filterString) {
      this.filters.push({ type: "or", value: filterString });
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

    head() {
      this.headMode = true;
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

      if (this.op === "insert") {
        const inserted = [];
        for (const row of this.values) {
          const duplicate = findDuplicate(table, row, options.uniqueKeys?.[this.table]);
          if (duplicate && options.rejectDuplicates?.[this.table] !== false) {
            return {
              data: single ? null : [],
              error: { code: "23505", message: "duplicate key value" },
              count: null,
            };
          }
          const next = {
            id: row.id || newId(this.table),
            created_at: row.created_at || new Date().toISOString(),
            updated_at: row.updated_at || new Date().toISOString(),
            ...row,
          };
          table.push(next);
          inserted.push(next);
        }
        if (this.countMode && this.headMode) {
          return { data: null, error: null, count: inserted.length };
        }
        return { data: single ? inserted[0] || null : inserted, error: null, count: null };
      }

      if (this.op === "update") {
        const updated = table.filter((row) => matches(row, this.filters));
        for (const row of updated) {
          Object.assign(row, this.patch, { updated_at: new Date().toISOString() });
        }
        if (this.countMode && this.headMode) {
          return { data: null, error: null, count: updated.length };
        }
        return { data: single ? updated[0] || null : updated, error: null, count: null };
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

      if (this.countMode) {
        return { data: this.headMode ? null : selected, error: null, count: selected.length };
      }

      return { data: single ? selected[0] || null : selected, error: null, count: null };
    }
  }

  return {
    rows,
    from(table) {
      return new Query(table);
    },
  };
}

// ─────────────────────────────────────────────
// Graph fixtures
// ─────────────────────────────────────────────

function baseDefinition(overrides = {}) {
  return {
    id: DEF_ID,
    definition_key: "proof_workflow",
    name: "Proof Workflow",
    status: "active",
    live_send_enabled: false,
    trigger_type: "lead_entered_workflow",
    metadata: {},
    ...overrides,
  };
}

function linearGraph({ includeTiming = false, includeCondition = false } = {}) {
  const trigId = "node-trig";
  const timingId = "node-timing";
  const condId = "node-cond";
  const actTrueId = "node-act-true";
  const actFalseId = "node-act-false";
  const actId = "node-act";

  const nodes = [
    {
      id: trigId,
      workflow_definition_id: DEF_ID,
      node_key: "trig",
      node_kind: "trigger",
      node_type: "trigger.lead_entered_workflow",
      label: "Trigger",
      config: {},
      is_active: true,
    },
  ];
  const edges = [];

  let prevId = trigId;

  if (includeTiming) {
    nodes.push({
      id: timingId,
      workflow_definition_id: DEF_ID,
      node_key: "wait",
      node_kind: "timing",
      node_type: "timing.wait_duration",
      label: "Wait",
      config: { amount: 1, unit: "minutes" },
      is_active: true,
    });
    edges.push({
      id: "edge-trig-timing",
      workflow_definition_id: DEF_ID,
      source_node_id: trigId,
      target_node_id: timingId,
      edge_type: "next",
    });
    prevId = timingId;
  }

  if (includeCondition) {
    nodes.push({
      id: condId,
      workflow_definition_id: DEF_ID,
      node_key: "cond_reply",
      node_kind: "condition",
      node_type: "condition.seller_replied",
      label: "Seller Replied?",
      config: {},
      is_active: true,
    });
    nodes.push({
      id: actTrueId,
      workflow_definition_id: DEF_ID,
      node_key: "act_true",
      node_kind: "action",
      node_type: "action.update_stage",
      label: "Replied Stage",
      config: { stage: "seller_replied" },
      is_active: true,
    });
    nodes.push({
      id: actFalseId,
      workflow_definition_id: DEF_ID,
      node_key: "act_false",
      node_kind: "action",
      node_type: "action.update_stage",
      label: "No Reply Stage",
      config: { stage: "awaiting_reply" },
      is_active: true,
    });
    edges.push({
      id: "edge-prev-cond",
      workflow_definition_id: DEF_ID,
      source_node_id: prevId,
      target_node_id: condId,
      edge_type: "next",
    });
    edges.push({
      id: "edge-cond-true",
      workflow_definition_id: DEF_ID,
      source_node_id: condId,
      target_node_id: actTrueId,
      edge_type: "true",
    });
    edges.push({
      id: "edge-cond-false",
      workflow_definition_id: DEF_ID,
      source_node_id: condId,
      target_node_id: actFalseId,
      edge_type: "false",
    });
    return { nodes, edges, trigId, timingId, condId, actTrueId, actFalseId };
  }

  nodes.push({
    id: actId,
    workflow_definition_id: DEF_ID,
    node_key: "act_done",
    node_kind: "action",
    node_type: "action.update_status",
    label: "Mark Processed",
    config: { status: "processed" },
    is_active: true,
  });
  edges.push({
    id: "edge-prev-act",
    workflow_definition_id: DEF_ID,
    source_node_id: prevId,
    target_node_id: actId,
    edge_type: "next",
  });

  return { nodes, edges, trigId, timingId, actId };
}

function seedRuntimeGraph(supabase, graphOptions = {}) {
  const graph = linearGraph(graphOptions);
  supabase.rows.workflow_definitions = [baseDefinition()];
  supabase.rows.workflow_nodes = graph.nodes;
  supabase.rows.workflow_edges = graph.edges;
  supabase.rows.workflow_enrollments = [];
  supabase.rows.workflow_runs = [];
  supabase.rows.workflow_run_steps = [];
  supabase.rows.workflow_events = [];
  supabase.rows.message_events = [];
  supabase.rows.master_owners = [];
  return graph;
}

// ─────────────────────────────────────────────
// Proof 1 — event creates one workflow enrollment
// ─────────────────────────────────────────────

test("proof 1: synthetic event creates exactly one workflow enrollment", async () => {
  const supabase = createFakeSupabase();
  seedRuntimeGraph(supabase);

  const result = await ingestWorkflowEvent(
    {
      event_type: "lead_entered_workflow",
      subject_type: "lead",
      subject_id: SUBJECT_ID,
      dedupe_key: "proof-event-001",
      context: CTX,
    },
    { supabase },
  );

  assert.equal(result.ok, true);
  assert.equal(supabase.rows.workflow_enrollments.length, 1, "one enrollment row");
  assert.equal(supabase.rows.workflow_enrollments[0].subject_id, SUBJECT_ID);
  assert.equal(supabase.rows.workflow_enrollments[0].workflow_definition_id, DEF_ID);
});

// ─────────────────────────────────────────────
// Proof 2 — duplicate event does not duplicate enrollment
// ─────────────────────────────────────────────

test("proof 2: duplicate event is deduped and does not create a second enrollment", async () => {
  const supabase = createFakeSupabase();
  seedRuntimeGraph(supabase);

  const payload = {
    event_type: "lead_entered_workflow",
    subject_type: "lead",
    subject_id: SUBJECT_ID,
    dedupe_key: "proof-event-dedupe-001",
    context: CTX,
  };

  const first = await ingestWorkflowEvent(payload, { supabase });
  assert.equal(first.ok, true);
  assert.equal(first.duplicate, undefined);

  const second = await ingestWorkflowEvent(payload, { supabase });
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(second.skipped, true);
  assert.equal(supabase.rows.workflow_enrollments.length, 1);
  assert.equal(supabase.rows.workflow_events.length, 1);
});

// ─────────────────────────────────────────────
// Proof 3 — workflow run survives restart (waiting state)
// ─────────────────────────────────────────────

test("proof 3: workflow run survives restart from waiting enrollment state", async () => {
  const supabase = createFakeSupabase();
  const graph = seedRuntimeGraph(supabase, { includeTiming: true });

  const past = new Date(Date.now() - 60_000).toISOString();
  supabase.rows.workflow_enrollments = [
    {
      id: ENROLL_ID,
      workflow_definition_id: DEF_ID,
      subject_type: "lead",
      subject_id: SUBJECT_ID,
      status: "waiting",
      current_node_id: graph.actId,
      context: { ...CTX },
      enrolled_at: new Date(Date.now() - 120_000).toISOString(),
      next_execution_at: past,
      waiting_reason: "timing.wait_duration",
    },
  ];

  const result = await runEnrollment(ENROLL_ID, { supabase });
  assert.equal(result.ok, true);
  assert.equal(result.run_status, "completed");

  const enrollment = supabase.rows.workflow_enrollments[0];
  assert.equal(enrollment.status, "completed");
  assert.ok(supabase.rows.workflow_runs.length >= 1, "new run record after restart");
});

// ─────────────────────────────────────────────
// Proof 4 — delay resumes correctly (timing.wait_duration)
// ─────────────────────────────────────────────

test("proof 4: timing.wait_duration pauses then resumes when due", async () => {
  const supabase = createFakeSupabase();
  const graph = seedRuntimeGraph(supabase, { includeTiming: true });

  supabase.rows.workflow_enrollments = [
    {
      id: ENROLL_ID,
      workflow_definition_id: DEF_ID,
      subject_type: "lead",
      subject_id: SUBJECT_ID,
      status: "active",
      current_node_id: null,
      context: { ...CTX },
      enrolled_at: new Date().toISOString(),
    },
  ];

  const first = await runEnrollment(ENROLL_ID, { supabase });
  assert.equal(first.ok, true);
  assert.equal(first.run_status, "waiting");

  const enrollment = supabase.rows.workflow_enrollments[0];
  assert.equal(enrollment.status, "waiting");
  assert.equal(enrollment.waiting_reason, "timing.wait_duration");
  assert.ok(enrollment.next_execution_at, "next_execution_at set");

  const expectedResume = calculateNextExecutionAt({ amount: 1, unit: "minutes" });
  const actualResume = new Date(enrollment.next_execution_at);
  assert.ok(
    Math.abs(actualResume.getTime() - expectedResume.getTime()) < 5_000,
    "resume time matches timing.wait_duration config",
  );

  enrollment.next_execution_at = new Date(Date.now() - 1_000).toISOString();
  const second = await runEnrollment(ENROLL_ID, { supabase });
  assert.equal(second.ok, true);
  assert.equal(second.run_status, "completed");
  assert.equal(supabase.rows.workflow_enrollments[0].status, "completed");
});

// ─────────────────────────────────────────────
// Proof 5 — branch selects correct path (condition)
// ─────────────────────────────────────────────

test("proof 5: condition branch routes to the true path when seller replied", async () => {
  const supabase = createFakeSupabase();
  const graph = seedRuntimeGraph(supabase, { includeCondition: true });
  const enrolledAt = new Date(Date.now() - 3_600_000).toISOString();

  supabase.rows.workflow_events = [
    {
      id: "evt-reply-001",
      event_type: "seller_replied",
      subject_id: SUBJECT_ID,
      created_at: new Date().toISOString(),
    },
  ];

  supabase.rows.workflow_enrollments = [
    {
      id: ENROLL_ID,
      workflow_definition_id: DEF_ID,
      subject_type: "lead",
      subject_id: SUBJECT_ID,
      status: "active",
      current_node_id: graph.condId,
      context: { ...CTX, subject_id: SUBJECT_ID },
      enrolled_at: enrolledAt,
    },
  ];

  const result = await runEnrollment(ENROLL_ID, { supabase });
  assert.equal(result.ok, true);

  const stageStep = supabase.rows.workflow_run_steps.find(
    (step) => step.node_key === "act_true",
  );
  assert.ok(stageStep, "true branch action executed");
  assert.equal(stageStep.execution_result.action?.target_stage, "seller_replied");
});

// ─────────────────────────────────────────────
// Proof 6 — communication action creates canonical no-send Queue row
// ─────────────────────────────────────────────

test("proof 6: communication action creates canonical no-send send_queue row", async () => {
  const supabase = createFakeSupabase({ send_queue: [] });

  const result = await enqueueWorkflowSms(
    {
      enrollment_id: ENROLL_ID,
      workflow_definition_id: DEF_ID,
      node_id: "node-sms-001",
      master_owner_id: CTX.master_owner_id,
      property_id: CTX.property_id,
      to_phone_number: CTX.phone,
      from_phone_number: CTX.from_phone_number,
      message_body: "Proof SMS body",
      queue_key: "proof-queue-001",
      dedupe_key: "proof-dedupe-001",
    },
    { supabase },
  );

  assert.equal(result.ok, true);
  assert.equal(result.duplicate, false);
  assert.equal(supabase.rows.send_queue.length, 1);

  const row = supabase.rows.send_queue[0];
  assert.equal(row.metadata?.no_send, true);
  assert.equal(row.metadata?.proof_no_send, true);
  assert.equal(row.metadata?.source, "workflow_v2");
  assert.equal(result.live_send_blocked, true);
});

// ─────────────────────────────────────────────
// Proof 7 — duplicate action creates zero duplicate Queue rows
// ─────────────────────────────────────────────

test("proof 7: duplicate communication enqueue does not create a second queue row", async () => {
  const supabase = createFakeSupabase({ send_queue: [] });

  const payload = {
    enrollment_id: ENROLL_ID,
    workflow_definition_id: DEF_ID,
    node_id: "node-sms-dup",
    master_owner_id: CTX.master_owner_id,
    property_id: CTX.property_id,
    to_phone_number: CTX.phone,
    message_body: "Duplicate guard proof",
    queue_key: "proof-queue-dup-001",
    dedupe_key: "proof-dedupe-dup-001",
  };

  const first = await enqueueWorkflowSms(payload, { supabase });
  const second = await enqueueWorkflowSms(payload, { supabase });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(supabase.rows.send_queue.length, 1, "only one canonical queue row");
});

// ─────────────────────────────────────────────
// Proof 8 — seller reply cancels pending follow-up
// ─────────────────────────────────────────────

test("proof 8: seller reply cancels pending follow-up tasks and queue rows", async () => {
  const supabase = createFakeSupabase({
    workflow_enrollments: [
      {
        id: ENROLL_ID,
        subject_type: "lead",
        subject_id: SUBJECT_ID,
        context: { ...CTX },
      },
    ],
    workflow_scheduled_tasks: [
      {
        id: "task-001",
        enrollment_id: ENROLL_ID,
        task_type: "follow_up",
        status: "pending",
        scheduled_for: new Date(Date.now() + 86_400_000).toISOString(),
      },
      {
        id: "task-002",
        enrollment_id: ENROLL_ID,
        task_type: "no_reply_follow_up",
        status: "pending",
        scheduled_for: new Date(Date.now() + 172_800_000).toISOString(),
      },
    ],
    send_queue: [
      {
        id: "queue-001",
        to_phone_number: CTX.phone,
        queue_status: "queued",
        metadata: { source: "workflow_v2", no_send: true },
      },
      {
        id: "queue-002",
        to_phone_number: CTX.phone,
        queue_status: "scheduled",
        metadata: { source: "workflow_v2", no_send: true },
      },
    ],
  });

  const result = await cancelFollowUpsOnReply(ENROLL_ID, { supabase });
  assert.equal(result.ok, true);
  assert.equal(result.cancelled_tasks, 2);
  assert.equal(result.cancelled_queue_rows, 2);

  for (const task of supabase.rows.workflow_scheduled_tasks) {
    assert.equal(task.status, "cancelled");
  }
  for (const row of supabase.rows.send_queue) {
    assert.equal(row.queue_status, "cancelled");
    assert.equal(row.paused_reason, "seller_replied");
  }
});

// ─────────────────────────────────────────────
// Proof 9 — transient failure schedules retry
// ─────────────────────────────────────────────

test("proof 9: transient delivery failure schedules a retry task", async () => {
  const supabase = createFakeSupabase({ workflow_scheduled_tasks: [] });
  const classification = classifyDeliveryFailure({ failure_reason: "provider_timeout" });
  assert.equal(classification.classification, "transient");

  const result = await handleDeliveryFailure({
    queueRow: { id: "queue-fail-001", retry_count: 0 },
    enrollment: { id: ENROLL_ID, workflow_definition_id: DEF_ID },
    context: { failure_reason: "provider_timeout" },
    deps: { supabase },
  });

  assert.equal(result.ok, true);
  assert.equal(result.retry_scheduled, true);
  assert.equal(result.retry_count, 1);
  assert.equal(supabase.rows.workflow_scheduled_tasks.length, 1);
  assert.equal(supabase.rows.workflow_scheduled_tasks[0].task_type, "delivery_retry");
});

// ─────────────────────────────────────────────
// Proof 10 — permanent failure does not retry
// ─────────────────────────────────────────────

test("proof 10: permanent delivery failure does not schedule retry", async () => {
  const supabase = createFakeSupabase({ workflow_scheduled_tasks: [] });
  const classification = classifyDeliveryFailure({ failure_reason: "seller_opt_out" });
  assert.equal(classification.classification, "permanent");

  const result = await handleDeliveryFailure({
    queueRow: { id: "queue-fail-002", retry_count: 0 },
    enrollment: { id: ENROLL_ID, workflow_definition_id: DEF_ID },
    context: { failure_reason: "seller_opt_out" },
    deps: { supabase },
  });

  assert.equal(result.retry_scheduled, false);
  assert.equal(result.permanent, true);
  assert.equal(supabase.rows.workflow_scheduled_tasks.length, 0);
});

// ─────────────────────────────────────────────
// Proof 11 — maximum three retries enforced
// ─────────────────────────────────────────────

test("proof 11: maximum of three retries is enforced", async () => {
  const supabase = createFakeSupabase({ workflow_scheduled_tasks: [] });
  assert.equal(MAX_RETRIES, 3);

  const exhausted = await handleDeliveryFailure({
    queueRow: { id: "queue-fail-003", retry_count: 3 },
    enrollment: { id: ENROLL_ID, workflow_definition_id: DEF_ID },
    context: { failure_reason: "provider_timeout" },
    deps: { supabase },
  });

  assert.equal(exhausted.retry_scheduled, false);
  assert.equal(exhausted.exhausted, true);
  assert.equal(supabase.rows.workflow_scheduled_tasks.length, 0);

  const thirdRetry = await handleDeliveryFailure({
    queueRow: { id: "queue-fail-004", retry_count: 2 },
    enrollment: { id: ENROLL_ID, workflow_definition_id: DEF_ID },
    context: { failure_reason: "provider_timeout" },
    deps: { supabase },
  });
  assert.equal(thirdRetry.retry_scheduled, true);
  assert.equal(thirdRetry.retry_count, 3);
});

// ─────────────────────────────────────────────
// Proof 12 — ownership confirmation advances stage
// ─────────────────────────────────────────────

test("proof 12: ownership confirmation advances workflow stage", async () => {
  const supabase = createFakeSupabase({
    workflow_enrollments: [
      {
        id: ENROLL_ID,
        workflow_definition_id: DEF_ID,
        subject_type: "lead",
        subject_id: SUBJECT_ID,
        status: "active",
        context: { ...CTX },
      },
    ],
    master_owners: [{ id: CTX.master_owner_id }],
  });

  const extracted = extractConversationFacts({
    message: { id: "msg-001", body: "Yes, I own this property." },
    enrollment: supabase.rows.workflow_enrollments[0],
  });
  const ownershipFact = extracted.facts.find((f) => f.fact_key === "ownership_status");
  assert.equal(ownershipFact?.fact_value?.value, "owner_confirmed");

  const stageNode = {
    id: "node-stage-ownership",
    node_key: "set_ownership_confirmed",
    node_kind: "action",
    node_type: "action.update_stage",
    config: { stage: "ownership_confirmed" },
  };

  const stageResult = await executeActionNode(
    stageNode,
    supabase.rows.workflow_enrollments[0],
    baseDefinition(),
    { supabase },
  );

  assert.equal(stageResult.status, "completed");
  assert.equal(stageResult.action.target_stage, "ownership_confirmed");

  const updateCall = supabase.rows.workflow_enrollments[0].context;
  assert.equal(updateCall.workflow_stage, "ownership_confirmed");
});

// ─────────────────────────────────────────────
// Proof 13 — asking price extracted
// ─────────────────────────────────────────────

test("proof 13: asking price is extracted from seller message", async () => {
  const extracted = extractConversationFacts({
    message: { id: "msg-002", body: "I want $275,000 for the property." },
    enrollment: { id: ENROLL_ID, context: CTX },
  });

  const priceFact = extracted.facts.find((f) => f.fact_key === "asking_price");
  assert.equal(priceFact?.fact_value?.value, 275000);
  assert.ok(priceFact.confidence >= 0.8);
});

// ─────────────────────────────────────────────
// Proof 14 — offer/ask ratios calculated
// ─────────────────────────────────────────────

test("proof 14: offer/ask ratios are calculated from acquisition output", async () => {
  const gap = calculateOfferAskGap(
    {
      asking_price: 250000,
      acquisition_output: {
        recommended_cash_offer: 200000,
        novation_offer: 225000,
        seller_finance_offer: 210000,
        subject_to_offer: 205000,
        best_strategy: "cash",
      },
    },
    null,
  );

  assert.equal(gap.asking_price, 250000);
  assert.equal(gap.cash_offer, 200000);
  assert.equal(gap.cash_ratio, 0.8);
  assert.equal(gap.novation_ratio, 0.9);
  assert.equal(gap.gap_percentage, 0.2);
  assert.ok(gap.recommended_negotiation_route);
});

// ─────────────────────────────────────────────
// Proof 15 — multifamily partial answers persist correctly
// ─────────────────────────────────────────────

test("proof 15: multifamily partial underwriting answers persist correctly", async () => {
  const supabase = createFakeSupabase({
    workflow_enrollments: [
      {
        id: ENROLL_ID,
        context: {
          ...CTX,
          asset_class: "multifamily_2_4",
          underwriting_facts: { unit_count: 3 },
        },
      },
    ],
  });

  const result = await persistPartialAnswers(
    ENROLL_ID,
    {
      monthly_rent_roll: 9200,
      operating_expenses: 1800,
    },
    { supabase },
  );

  assert.equal(result.ok, true);
  assert.equal(result.underwriting_facts.unit_count, 3, "existing answer preserved");
  assert.equal(result.underwriting_facts.monthly_rent_roll, 9200);
  assert.equal(result.underwriting_facts.operating_expenses, 1800);
});

// ─────────────────────────────────────────────
// Proof 16 — only missing underwriting questions asked
// ─────────────────────────────────────────────

test("proof 16: only missing underwriting questions are generated", async () => {
  const context = {
    asset_class: "multifamily_2_4",
    underwriting_facts: {
      unit_count: 4,
      monthly_rent_roll: 11000,
      asking_price: 450000,
    },
  };

  const missing = getMissingFacts("multifamily_2_4", context);
  assert.ok(!missing.includes("unit_count"));
  assert.ok(!missing.includes("monthly_rent_roll"));
  assert.ok(!missing.includes("asking_price"));
  assert.ok(missing.includes("operating_expenses"));

  const questions = buildUnderwritingQuestions("multifamily_2_4", context);
  const keys = questions.map((q) => q.fact_key);
  assert.ok(!keys.includes("unit_count"));
  assert.ok(keys.includes("operating_expenses"));
});

// ─────────────────────────────────────────────
// Proof 17 — cooperation score calculated and explained
// ─────────────────────────────────────────────

test("proof 17: cooperation score is calculated with explained reasons", async () => {
  const supabase = createFakeSupabase({
    workflow_enrollments: [
      {
        id: ENROLL_ID,
        subject_type: "lead",
        subject_id: SUBJECT_ID,
        context: {
          ...CTX,
          avg_response_time_hours: 3,
          question_completion_rate: 0.8,
        },
      },
    ],
  });

  const enrollment = supabase.rows.workflow_enrollments[0];
  const facts = [
    {
      fact_key: "seller_interest_level",
      fact_value: { value: "interested" },
      confidence: 0.9,
    },
  ];

  const score = calculateSellerCooperation(enrollment, facts);
  assert.ok(score.score >= 70, `expected cooperative score, got ${score.score}`);
  assert.ok(score.reasons.length > 0, "score includes explained reasons");
  assert.ok(score.reasons.some((r) => r.reason === "seller_interested"));

  const persisted = await persistCooperationScore(enrollment, score, { supabase });
  assert.equal(persisted.ok, true);
  assert.equal(supabase.rows.workflow_seller_cooperation.length, 1);
  assert.equal(enrollment.context.seller_cooperation_score, persisted.record.score);
});

// ─────────────────────────────────────────────
// Proof 18 — human approval blocks protected actions
// ─────────────────────────────────────────────

test("proof 18: human approval guard blocks protected actions without approval", async () => {
  delete process.env.WORKFLOW_KILL_SWITCH;

  const blocked = await evaluateGuardNode(
    { node_type: "guard.approval_required" },
    { id: ENROLL_ID, context: { human_approval_status: "pending" } },
    baseDefinition(),
    {},
  );
  assert.equal(blocked.passed, false);
  assert.equal(blocked.reason, "human_approval_required");

  const approved = await evaluateGuardNode(
    { node_type: "guard.approval_required" },
    { id: ENROLL_ID, context: { human_approval_status: "approved" } },
    baseDefinition(),
    {},
  );
  assert.equal(approved.passed, true);

  const killSwitch = await evaluateGuardNode(
    { node_type: "guard.workflow_kill_switch" },
    { id: ENROLL_ID, context: CTX },
    baseDefinition(),
    {},
  );
  assert.equal(killSwitch.passed, true, "WORKFLOW_KILL_SWITCH unset allows execution");
});

// ─────────────────────────────────────────────
// Proof 19 — pause/resume works
// ─────────────────────────────────────────────

test("proof 19: pause and resume enrollment run control works", async () => {
  const supabase = createFakeSupabase({
    workflow_enrollments: [
      {
        id: ENROLL_ID,
        workflow_definition_id: DEF_ID,
        subject_type: "lead",
        subject_id: SUBJECT_ID,
        status: "active",
        context: CTX,
      },
    ],
  });

  const paused = await pauseEnrollment(ENROLL_ID, "operator_hold", { supabase });
  assert.equal(paused.ok, true);
  assert.equal(paused.enrollment.status, "waiting");
  assert.equal(paused.enrollment.pause_reason, "operator_hold");

  const resumed = await resumeEnrollment(ENROLL_ID, { supabase });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.enrollment.status, "active");
  assert.equal(resumed.enrollment.pause_reason, null);
});

// ─────────────────────────────────────────────
// Proof 20 — complete run history appears
// ─────────────────────────────────────────────

test("proof 20: complete run history includes workflow_runs and workflow_run_steps", async () => {
  const supabase = createFakeSupabase({
    workflow_runs: [
      {
        id: "run-proof-001",
        workflow_definition_id: DEF_ID,
        enrollment_id: ENROLL_ID,
        status: "completed",
        started_at: "2026-06-20T10:00:00.000Z",
        completed_at: "2026-06-20T10:00:05.000Z",
      },
      {
        id: "run-proof-002",
        workflow_definition_id: DEF_ID,
        enrollment_id: ENROLL_ID,
        status: "waiting",
        started_at: "2026-06-20T11:00:00.000Z",
      },
    ],
    workflow_run_steps: [
      {
        id: "step-001",
        workflow_run_id: "run-proof-001",
        node_key: "trig",
        node_type: "trigger.lead_entered_workflow",
        status: "triggered",
        created_at: "2026-06-20T10:00:01.000Z",
      },
      {
        id: "step-002",
        workflow_run_id: "run-proof-001",
        node_key: "act_done",
        node_type: "action.update_status",
        status: "completed",
        created_at: "2026-06-20T10:00:02.000Z",
      },
      {
        id: "step-003",
        workflow_run_id: "run-proof-002",
        node_key: "wait",
        node_type: "timing.wait_duration",
        status: "waiting",
        created_at: "2026-06-20T11:00:01.000Z",
      },
    ],
  });

  const history = await getRunHistory(DEF_ID, { supabase });
  assert.equal(history.ok, true);
  assert.equal(history.runs.length, 2);

  const completedRun = history.runs.find((run) => run.id === "run-proof-001");
  assert.equal(completedRun.steps.length, 2);
  assert.ok(completedRun.steps.some((s) => s.node_type === "trigger.lead_entered_workflow"));
  assert.ok(completedRun.steps.some((s) => s.node_type === "action.update_status"));

  const waitingRun = history.runs.find((run) => run.id === "run-proof-002");
  assert.equal(waitingRun.steps.length, 1);
  assert.equal(waitingRun.steps[0].node_type, "timing.wait_duration");
});

// ─────────────────────────────────────────────
// Supplemental — processEvent enrollment idempotency
// ─────────────────────────────────────────────

test("proof 2b: processEvent re-enrollment merges context without duplicate insert", async () => {
  const supabase = createFakeSupabase();
  seedRuntimeGraph(supabase);

  const first = await processEvent(
    {
      event_type: "lead_entered_workflow",
      subject_type: "lead",
      subject_id: SUBJECT_ID,
      context: { ...CTX, custom_marker: "first" },
    },
    { supabase },
  );
  assert.equal(first.ok, true);

  const second = await processEvent(
    {
      event_type: "lead_entered_workflow",
      subject_type: "lead",
      subject_id: SUBJECT_ID,
      context: { thread_id: "merged-thread", custom_marker: "second" },
    },
    { supabase },
  );
  assert.equal(second.ok, true);
  assert.equal(supabase.rows.workflow_enrollments.length, 1);
  assert.equal(supabase.rows.workflow_enrollments[0].context.thread_id, "merged-thread");
  assert.equal(supabase.rows.workflow_enrollments[0].context.custom_marker, "second");
});

test("proof 13b: extracted asking price facts can be persisted", async () => {
  const supabase = createFakeSupabase({
    workflow_enrollments: [
      {
        id: ENROLL_ID,
        subject_type: "lead",
        subject_id: SUBJECT_ID,
        context: CTX,
      },
    ],
    workflow_extracted_facts: [],
  });

  const extracted = extractConversationFacts({
    message: { id: "msg-003", body: "Looking for $310,000 net." },
    enrollment: supabase.rows.workflow_enrollments[0],
  });

  const saved = await persistExtractedFacts(
    supabase.rows.workflow_enrollments[0],
    extracted.facts,
    { supabase },
  );
  assert.equal(saved.ok, true);
  assert.equal(saved.saved.length, 1);
  assert.equal(saved.saved[0].fact_key, "asking_price");
});

// ─────────────────────────────────────────────
// System workflow template library
// ─────────────────────────────────────────────

test("system templates: seeds 13 locked versioned workflows", async () => {
  const { seedSystemWorkflowTemplates, SYSTEM_WORKFLOW_TEMPLATES, protectSystemTemplateEdit } =
    await import("@/lib/domain/workflow-v2/system-templates.js");

  const supabase = createFakeSupabase();
  const result = await seedSystemWorkflowTemplates({ supabase });
  assert.equal(result.ok, true);
  assert.equal(result.seeded.length, SYSTEM_WORKFLOW_TEMPLATES.length);
  assert.equal(supabase.rows.workflow_definitions.length, 13);

  for (const def of supabase.rows.workflow_definitions) {
    assert.equal(def.is_system_template, true);
    assert.equal(def.is_locked, true);
    assert.equal(def.live_send_enabled, false);
    const blocked = protectSystemTemplateEdit(def);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error, "system_template_locked");
  }

  const secondSeed = await seedSystemWorkflowTemplates({ supabase });
  assert.equal(secondSeed.skipped.length, 13);
  assert.equal(secondSeed.seeded.length, 0);
});