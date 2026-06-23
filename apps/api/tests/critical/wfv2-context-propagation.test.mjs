// wfv2-context-propagation.test.mjs
//
// Proves that the 12 canonical workflow context fields survive every hop:
//   workflow_event.payload
//   → workflow_enrollments.context  (create + merge)
//   → workflow_runs.context
//   → workflow_run_steps.execution_result._context
//   → workflow_run_steps.execution_result._context_used  (action executor)
//
// Run: npm run proof:wfv2-ctx

import test from "node:test";
import assert from "node:assert/strict";

import { ingestWorkflowEvent } from "@/lib/domain/workflow-v2/events-service.js";
import { enrollSubject } from "@/lib/domain/workflow-v2/enrollment-service.js";
import { executeActionNode } from "@/lib/domain/workflow-v2/action-executor.js";
import { runEnrollment } from "@/lib/domain/workflow-v2/workflow-runner.js";

// ─────────────────────────────────────────────
// Canonical context — all 12 required fields
// ─────────────────────────────────────────────

const CTX = {
  master_owner_id: "ctx-mo-001",
  thread_id:       "ctx-thread-001",
  conversation_id: "ctx-conv-001",
  property_id:     "ctx-prop-001",
  campaign_id:     "ctx-camp-001",
  stage:           "initial_outreach",
  status:          "new_lead",
  phone:           "+15551230001",
  email:           "ctx@example.com",
  market:          "dallas",
  state:           "TX",
  city:            "Dallas",
};

function assertAllContextFields(obj, label) {
  for (const [key, expected] of Object.entries(CTX)) {
    assert.equal(
      obj[key],
      expected,
      `${label}: expected ${key}="${expected}" but got "${obj[key]}"`,
    );
  }
}

// ─────────────────────────────────────────────
// Mock Supabase client builder
//
// config keys: "<table>.<op>"  e.g. "workflow_events.insert"
// The chain is thenable so both `await chain.select(...)` and
// `chain.select(...).single()` resolve correctly.
// ─────────────────────────────────────────────

function makeClient(config = {}) {
  const calls = [];

  function resolve(table, op) {
    const r =
      config[`${table}.${op}`] ??
      config[table] ??
      { data: null, error: null };
    return typeof r === "function" ? r() : r;
  }

  function chain(table, op) {
    const c = {
      // Preserve current op so insert().select().single() resolves to 'insert',
      // while from(t).select().maybeSingle() still resolves to 'select'.
      select:     ()        => chain(table, op ?? "select"),
      insert:     (data)    => { calls.push({ table, op: "insert", data }); return chain(table, "insert"); },
      update:     (data)    => { calls.push({ table, op: "update", data }); return chain(table, "update"); },
      upsert:     (data, o) => { calls.push({ table, op: "upsert", data, opts: o }); return chain(table, "upsert"); },
      delete:     ()        => chain(table, "delete"),
      eq:         ()        => c,
      in:         ()        => c,
      or:         ()        => c,
      gte:        ()        => c,
      lte:        ()        => c,
      order:      ()        => c,
      limit:      ()        => c,
      head:       ()        => c,
      maybeSingle: ()       => Promise.resolve(resolve(table, op ?? "select")),
      single:      ()       => Promise.resolve(resolve(table, op ?? "select")),
      // thenable: allows `await client.from(t).select(...)` direct awaits
      then: (res, rej)      => Promise.resolve(resolve(table, op ?? "select")).then(res, rej),
    };
    return c;
  }

  return { calls, from: (table) => chain(table, null) };
}

// ─────────────────────────────────────────────
// Shared fixtures
// ─────────────────────────────────────────────

const DEF_ID   = "def-001";
const ENROLL_ID = "enroll-001";
const RUN_ID   = "run-001";
const TRIG_ID  = "node-trig";
const ACT_ID   = "node-act";

const FAKE_DEF = {
  id: DEF_ID, definition_key: "test", name: "Test WF",
  status: "active", live_send_enabled: false,
  trigger_type: "lead_entered_workflow", metadata: {},
};

const FAKE_ENROLLMENT = {
  id: ENROLL_ID,
  workflow_definition_id: DEF_ID,
  subject_type: "lead",
  subject_id: "sub-001",
  status: "active",
  current_node_id: null,
  context: { ...CTX },
  enrolled_at: new Date().toISOString(),
  completed_at: null,
  terminated_at: null,
  next_execution_at: null,
  waiting_reason: null,
};

const FAKE_TRIG_NODE = {
  id: TRIG_ID,
  workflow_definition_id: DEF_ID,
  node_key: "trig",
  node_kind: "trigger",
  node_type: "trigger.lead_entered_workflow",
  label: "Trigger",
  config: {},
  is_active: true,
};

const FAKE_ACT_NODE = {
  id: ACT_ID,
  workflow_definition_id: DEF_ID,
  node_key: "act",
  node_kind: "action",
  node_type: "action.update_status",
  label: "Set Status",
  config: { status: "processed" },
  is_active: true,
};

const FAKE_EDGE = {
  id: "edge-001",
  workflow_definition_id: DEF_ID,
  source_node_id: TRIG_ID,
  target_node_id: ACT_ID,
  edge_type: "next",
  condition_key: null,
};

const FAKE_RUN = {
  id: RUN_ID,
  workflow_definition_id: DEF_ID,
  enrollment_id: ENROLL_ID,
  status: "running",
  dry_run: false,
  live_send_enabled: false,
  context: { ...CTX },
  started_at: new Date().toISOString(),
};

// ─────────────────────────────────────────────
// Hop 1 — events-service: context field → workflow_events.payload
// ─────────────────────────────────────────────

test("events-service: context field is stored as workflow_events.payload", async () => {
  const fakeEvent = {
    id: "evt-001", event_type: "lead_entered_workflow",
    subject_id: "sub-001", status: "pending",
    dedupe_key: "dk-001", payload: CTX,
    created_at: new Date().toISOString(),
  };

  const client = makeClient({
    "workflow_events.insert":  { data: fakeEvent, error: null },
    "workflow_definitions.select": { data: [], error: null },
    "workflow_events.update":  { data: { status: "no_match" }, error: null },
  });

  await ingestWorkflowEvent(
    { event_type: "lead_entered_workflow", subject_id: "sub-001", context: CTX },
    { supabase: client },
  );

  const eventInsert = client.calls.find((c) => c.table === "workflow_events" && c.op === "insert");
  assert.ok(eventInsert, "workflow_events insert was not called");
  assertAllContextFields(eventInsert.data.payload, "workflow_events.payload");
});

test("events-service: payload field (legacy) is NOT used as context", async () => {
  const fakeEvent = {
    id: "evt-002", event_type: "lead_entered_workflow",
    subject_id: "sub-002", status: "pending",
    dedupe_key: "dk-002", payload: CTX,
    created_at: new Date().toISOString(),
  };

  const client = makeClient({
    "workflow_events.insert":  { data: fakeEvent, error: null },
    "workflow_definitions.select": { data: [], error: null },
    "workflow_events.update":  { data: { status: "no_match" }, error: null },
  });

  // Send context under "context", not "payload" — correct API contract
  await ingestWorkflowEvent(
    {
      event_type: "lead_entered_workflow",
      subject_id: "sub-002",
      context: CTX,
      payload: { wrong_field: true }, // legacy payload should NOT bleed into context
    },
    { supabase: client },
  );

  const insert = client.calls.find((c) => c.table === "workflow_events" && c.op === "insert");
  assert.equal(
    insert?.data?.payload?.master_owner_id,
    CTX.master_owner_id,
    "context.master_owner_id must come from context field, not payload",
  );
  assert.equal(
    insert?.data?.payload?.wrong_field,
    undefined,
    "payload.wrong_field must not bleed into workflow_events.payload",
  );
});

// ─────────────────────────────────────────────
// Hop 2 — enrollment-service: context stored on create
// ─────────────────────────────────────────────

test("enrollSubject: context stored in workflow_enrollments on create", async () => {
  const stored = { ...FAKE_ENROLLMENT };
  const client = makeClient({
    "workflow_definitions.select": { data: FAKE_DEF, error: null },
    "workflow_enrollments.select": { data: null, error: null },   // no existing
    "workflow_enrollments.insert": { data: stored, error: null },
  });

  const result = await enrollSubject(
    DEF_ID,
    { subject_type: "lead", subject_id: "sub-001", context: CTX },
    { supabase: client },
  );

  assert.ok(result.ok, `enrollSubject failed: ${result.error}`);

  const insertCall = client.calls.find(
    (c) => c.table === "workflow_enrollments" && c.op === "insert",
  );
  assert.ok(insertCall, "workflow_enrollments insert was not called");
  assertAllContextFields(insertCall.data.context, "enrollment insert context");
});

// ─────────────────────────────────────────────
// Hop 2b — enrollment-service: context MERGED on re-enrollment
// ─────────────────────────────────────────────

test("enrollSubject: context is merged (not replaced) on re-enrollment", async () => {
  const existingContext = {
    master_owner_id: "mo-original",
    phone: "+15559990000",
    custom_field: "preserved",  // must survive merge
  };

  const incomingContext = {
    master_owner_id: "mo-updated",  // overrides existing
    thread_id: "thread-new",        // new field added
  };

  const expectedMerged = {
    master_owner_id: "mo-updated",  // updated
    phone: "+15559990000",          // preserved from existing
    custom_field: "preserved",      // preserved from existing
    thread_id: "thread-new",        // added from incoming
  };

  const existingEnrollment = { ...FAKE_ENROLLMENT, context: existingContext };
  const mergedEnrollment = { ...FAKE_ENROLLMENT, context: expectedMerged };

  const client = makeClient({
    "workflow_definitions.select": { data: FAKE_DEF, error: null },
    "workflow_enrollments.select": { data: existingEnrollment, error: null },
    "workflow_enrollments.update": { data: mergedEnrollment, error: null },
  });

  const result = await enrollSubject(
    DEF_ID,
    { subject_type: "lead", subject_id: "sub-001", context: incomingContext },
    { supabase: client },
  );

  assert.ok(result.ok, `enrollSubject failed: ${result.error}`);

  const updateCall = client.calls.find(
    (c) => c.table === "workflow_enrollments" && c.op === "update",
  );
  assert.ok(updateCall, "workflow_enrollments update was not called for re-enrollment");

  const merged = updateCall.data.context;
  assert.equal(merged.master_owner_id, "mo-updated",   "master_owner_id must be updated");
  assert.equal(merged.phone,           "+15559990000",  "phone must be preserved from existing");
  assert.equal(merged.custom_field,    "preserved",     "custom_field must be preserved");
  assert.equal(merged.thread_id,       "thread-new",    "thread_id must be added");
});

test("enrollSubject: INSERT is used (not UPDATE) for a fresh enrollment", async () => {
  const client = makeClient({
    "workflow_definitions.select": { data: FAKE_DEF, error: null },
    "workflow_enrollments.select": { data: null, error: null },
    "workflow_enrollments.insert": { data: FAKE_ENROLLMENT, error: null },
  });

  await enrollSubject(
    DEF_ID,
    { subject_type: "lead", subject_id: "sub-new", context: CTX },
    { supabase: client },
  );

  const insertCalls = client.calls.filter(
    (c) => c.table === "workflow_enrollments" && c.op === "insert",
  );
  const updateCalls = client.calls.filter(
    (c) => c.table === "workflow_enrollments" && c.op === "update",
  );
  assert.equal(insertCalls.length, 1, "should INSERT for new enrollment");
  assert.equal(updateCalls.length, 0, "should NOT UPDATE for new enrollment");
});

// ─────────────────────────────────────────────
// Hop 4 — action-executor: _context_used in every result
// ─────────────────────────────────────────────

test("executeActionNode: _context_used present with all canonical fields", async () => {
  const contextUpdated = { ...FAKE_ENROLLMENT };
  const client = makeClient({
    "workflow_enrollments.select": { data: FAKE_ENROLLMENT, error: null },
    "workflow_enrollments.update": { data: contextUpdated, error: null },
    "master_owners.update":        { data: {}, error: null },
  });

  const result = await executeActionNode(
    FAKE_ACT_NODE,
    FAKE_ENROLLMENT,
    FAKE_DEF,
    { supabase: client },
  );

  assert.ok(result._context_used, "result must have _context_used");
  assertAllContextFields(result._context_used, "action _context_used");
});

test("executeActionNode: _context_used present for action.update_stage", async () => {
  const stageNode = {
    ...FAKE_ACT_NODE,
    node_type: "action.update_stage",
    node_key: "set_stage",
    config: { stage: "under_contract" },
  };
  const client = makeClient({
    "workflow_enrollments.select": { data: FAKE_ENROLLMENT, error: null },
    "workflow_enrollments.update": { data: FAKE_ENROLLMENT, error: null },
    "master_owners.update":        { data: {}, error: null },
  });

  const result = await executeActionNode(stageNode, FAKE_ENROLLMENT, FAKE_DEF, { supabase: client });

  assert.ok(result._context_used, "result must have _context_used");
  assert.equal(result._context_used.master_owner_id, CTX.master_owner_id);
  assert.equal(result._context_used.phone, CTX.phone);
});

test("executeActionNode: _context_used present for action.send_sms (blocked)", async () => {
  const smsNode = {
    ...FAKE_ACT_NODE,
    node_type: "action.send_sms",
    node_key: "send_sms",
    config: { body: "Hello {{name}}" },
  };

  const result = await executeActionNode(smsNode, FAKE_ENROLLMENT, FAKE_DEF, {});

  assert.equal(result.live_send_blocked, true,       "send_sms must be blocked");
  assert.equal(result.status, "blocked",              "status must be blocked");
  assert.ok(result._context_used,                     "result must have _context_used");
  assert.equal(result._context_used.phone, CTX.phone, "_context_used.phone must match");
});

test("executeActionNode: _context_used present for unknown action (scaffolded)", async () => {
  const unknownNode = {
    ...FAKE_ACT_NODE,
    node_type: "action.future_action",
    node_key: "future",
    config: {},
  };

  const result = await executeActionNode(unknownNode, FAKE_ENROLLMENT, FAKE_DEF, {});

  assert.equal(result.status, "scaffolded");
  assert.ok(result._context_used, "scaffolded result must have _context_used");
});

// ─────────────────────────────────────────────
// Hops 3 + 4 — workflow-runner: _context in run record and run steps
// ─────────────────────────────────────────────

test("runEnrollment: workflow_runs.context is flat enrollment context (not nested)", async () => {
  const runInserted = { ...FAKE_RUN };
  const actEnrollment = { ...FAKE_ENROLLMENT };
  const completedEnrollment = { ...FAKE_ENROLLMENT, status: "completed", completed_at: new Date().toISOString() };

  const client = makeClient({
    // Runner loads enrollment
    "workflow_enrollments.select": { data: FAKE_ENROLLMENT, error: null },
    // Runner loads definition
    "workflow_definitions.select":  { data: FAKE_DEF, error: null },
    // Runner loads nodes
    "workflow_nodes.select":  { data: [FAKE_TRIG_NODE, FAKE_ACT_NODE], error: null },
    // Runner loads edges
    "workflow_edges.select":  { data: [FAKE_EDGE], error: null },
    // Runner creates workflow_run
    "workflow_runs.insert":  { data: runInserted, error: null },
    // Runner updates workflow_run on completion
    "workflow_runs.update":  { data: runInserted, error: null },
    // Runner inserts run steps
    "workflow_run_steps.insert": { data: {}, error: null },
    // Action executor: updateEnrollmentContext reads enrollment then updates
    "workflow_enrollments.update": { data: actEnrollment, error: null },
    // Action executor: master_owners update (master_owner_id exists in context)
    "master_owners.update": { data: {}, error: null },
    // completeEnrollment update
  });

  await runEnrollment(ENROLL_ID, { supabase: client });

  const runInsert = client.calls.find((c) => c.table === "workflow_runs" && c.op === "insert");
  assert.ok(runInsert, "workflow_runs.insert must be called");

  // context must be the flat enrollment context, not { subject: { ... } }
  const runContext = runInsert.data.context;
  assert.equal(
    typeof runContext.master_owner_id !== "undefined" ? "flat" : "nested",
    "flat",
    "workflow_runs.context must be flat (not wrapped in { subject: ... })",
  );
  assertAllContextFields(runContext, "workflow_runs.context");
});

test("runEnrollment: workflow_run_steps include _context snapshot", async () => {
  const runInserted = { ...FAKE_RUN };
  const actEnrollment = { ...FAKE_ENROLLMENT };

  const client = makeClient({
    "workflow_enrollments.select": { data: FAKE_ENROLLMENT, error: null },
    "workflow_definitions.select":  { data: FAKE_DEF, error: null },
    "workflow_nodes.select":  { data: [FAKE_TRIG_NODE, FAKE_ACT_NODE], error: null },
    "workflow_edges.select":  { data: [FAKE_EDGE], error: null },
    "workflow_runs.insert":  { data: runInserted, error: null },
    "workflow_runs.update":  { data: runInserted, error: null },
    "workflow_run_steps.insert": { data: {}, error: null },
    "workflow_enrollments.update": { data: actEnrollment, error: null },
    "master_owners.update": { data: {}, error: null },
  });

  await runEnrollment(ENROLL_ID, { supabase: client });

  const stepInserts = client.calls.filter(
    (c) => c.table === "workflow_run_steps" && c.op === "insert",
  );
  assert.ok(stepInserts.length > 0, "workflow_run_steps inserts must be called");

  for (const step of stepInserts) {
    const execResult = step.data.execution_result;
    assert.ok(execResult._context, `step ${step.data?.node_key}: missing execution_result._context`);
    assertAllContextFields(
      execResult._context,
      `workflow_run_steps[${step.data?.node_key}].execution_result._context`,
    );
  }
});

test("runEnrollment: action step _context_used contains all canonical fields", async () => {
  const runInserted = { ...FAKE_RUN };
  const actEnrollment = { ...FAKE_ENROLLMENT };

  const client = makeClient({
    "workflow_enrollments.select": { data: FAKE_ENROLLMENT, error: null },
    "workflow_definitions.select":  { data: FAKE_DEF, error: null },
    "workflow_nodes.select":  { data: [FAKE_TRIG_NODE, FAKE_ACT_NODE], error: null },
    "workflow_edges.select":  { data: [FAKE_EDGE], error: null },
    "workflow_runs.insert":  { data: runInserted, error: null },
    "workflow_runs.update":  { data: runInserted, error: null },
    "workflow_run_steps.insert": { data: {}, error: null },
    "workflow_enrollments.update": { data: actEnrollment, error: null },
    "master_owners.update": { data: {}, error: null },
  });

  await runEnrollment(ENROLL_ID, { supabase: client });

  const actionStep = client.calls.find(
    (c) =>
      c.table === "workflow_run_steps" &&
      c.op === "insert" &&
      c.data?.node_type === "action.update_status",
  );
  assert.ok(actionStep, "action.update_status step must be persisted");

  const contextUsed = actionStep.data.execution_result._context_used;
  assert.ok(contextUsed, "action step must have _context_used in execution_result");
  assertAllContextFields(contextUsed, "action step _context_used");
});
