import test from "node:test";
import assert from "node:assert/strict";

import {
  createWorkflow,
  createWorkflowSenderPool,
  createWorkflowSenderPoolMember,
  createWorkflowStep,
  createWorkflowTemplateSet,
  createWorkflowTemplateVariant,
  getWorkflow,
  listWorkflows,
  updateWorkflow,
  upsertWorkflowTemplateTranslation,
} from "@/lib/domain/workflows/workflow-service.js";
import { dryRunWorkflow } from "@/lib/domain/workflows/workflow-dry-run.js";
import { routeWorkflowSender } from "@/lib/domain/workflows/workflow-sender-router.js";
import { applyWorkflowSpinSyntax } from "@/lib/domain/workflows/workflow-spin-syntax.js";
import { renderWorkflowTemplate } from "@/lib/domain/workflows/workflow-template-renderer.js";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function clean(value) {
  return String(value ?? "").trim();
}

function createFakeSupabase(seed = {}) {
  const rows = Object.fromEntries(
    Object.entries(seed).map(([table, tableRows]) => [table, tableRows.map(clone)])
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
      if (filter.type === "eq") return clean(row[filter.column]) === clean(filter.value);
      if (filter.type === "in") {
        const values = (filter.values || []).map(clean);
        return values.includes(clean(row[filter.column]));
      }
      return true;
    });
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
    }

    select() {
      return this;
    }

    insert(value) {
      this.op = "insert";
      this.values = Array.isArray(value) ? value.map(clone) : [clone(value)];
      return this;
    }

    upsert(value, options = {}) {
      this.op = "upsert";
      this.values = Array.isArray(value) ? value.map(clone) : [clone(value)];
      this.conflictKeys = clean(options.onConflict)
        .split(",")
        .map((key) => key.trim())
        .filter(Boolean);
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

    order(column, options = {}) {
      this.orderBy = { column, ascending: options.ascending !== false };
      return this;
    }

    limit(count) {
      this.limitCount = Number(count);
      return this;
    }

    single() {
      return this.execute(true);
    }

    maybeSingle() {
      return this.execute(true);
    }

    then(resolve, reject) {
      return this.execute(false).then(resolve, reject);
    }

    async execute(single = false) {
      const table = tableRows(this.table);

      if (this.op === "insert") {
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

      if (this.op === "upsert") {
        const upserted = this.values.map((row) => {
          const keys = this.conflictKeys.length ? this.conflictKeys : ["id"];
          const existing = table.find((candidate) =>
            keys.every((key) => clean(candidate[key]) === clean(row[key]))
          );
          if (existing) {
            Object.assign(existing, row, { updated_at: new Date().toISOString() });
            return existing;
          }
          const next = {
            id: row.id || newId(this.table),
            created_at: row.created_at || new Date().toISOString(),
            updated_at: row.updated_at || new Date().toISOString(),
            ...row,
          };
          table.push(next);
          return next;
        });
        return { data: single ? upserted[0] || null : upserted, error: null };
      }

      if (this.op === "update") {
        const updated = table.filter((row) => matches(row, this.filters));
        for (const row of updated) {
          Object.assign(row, this.patch, { updated_at: new Date().toISOString() });
        }
        return { data: single ? updated[0] || null : updated, error: null };
      }

      let selected = table.filter((row) => matches(row, this.filters));
      if (this.orderBy) {
        const { column, ascending } = this.orderBy;
        selected = [...selected].sort((a, b) => {
          const av = clean(a[column]);
          const bv = clean(b[column]);
          if (av === bv) return 0;
          return ascending ? (av < bv ? -1 : 1) : (av < bv ? 1 : -1);
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

test("workflow service creates, lists, updates, and rejects live-send enablement", async () => {
  const supabase = createFakeSupabase();
  const live = await createWorkflow({
    name: "Unsafe Workflow",
    live_send_enabled: true,
  }, { supabase });
  assert.equal(live.ok, false);
  assert.equal(live.error, "workflow_live_send_disabled");

  const created = await createWorkflow({
    name: "Owner Check Workflow",
    channel: "sms",
    workflow_type: "outbound",
    market_scope: ["austin_tx"],
    state_scope: ["TX"],
    language_scope: ["en"],
  }, { supabase });
  assert.equal(created.ok, true);
  assert.equal(created.workflow.live_send_enabled, false);

  const listed = await listWorkflows({ supabase });
  assert.equal(listed.workflows.length, 1);

  const updated = await updateWorkflow(created.workflow_id, { status: "paused" }, { supabase });
  assert.equal(updated.workflow.status, "paused");
  assert.equal(updated.workflow.live_send_enabled, false);
});

test("workflow spin syntax and token rendering are deterministic", () => {
  const template = "Hi {first_name}, {are you open|would you consider} talking about {property_address}?";
  const first = applyWorkflowSpinSyntax(template, {
    conversation_thread_id: "thread-1",
    step_id: "step-1",
  });
  const second = applyWorkflowSpinSyntax(template, {
    conversation_thread_id: "thread-1",
    step_id: "step-1",
  });
  assert.deepEqual(first, second);

  const rendered = renderWorkflowTemplate({
    id: "variant-1",
    variant_key: "a",
    language: "en",
    body: template,
    spin_syntax_enabled: true,
  }, {
    conversation_thread_id: "thread-1",
    step_id: "step-1",
    first_name: "Jordan",
    property_address: "123 Main St",
  });
  assert.match(rendered.body, /Jordan/);
  assert.match(rendered.body, /123 Main St/);
  assert.equal(rendered.sms.segment_count, 1);
  assert.equal(rendered.spin_substitutions.length, 1);
});

test("workflow sender routing prefers exact market and blocks unsafe fallback", async () => {
  const supabase = createFakeSupabase({
    workflow_sender_pools: [
      {
        id: "pool-1",
        workflow_id: "workflow-1",
        name: "Austin Pool",
        channel: "sms",
        market_scope: ["austin_tx"],
        state_scope: ["TX"],
        language_scope: ["en"],
        routing_mode: "exact_market",
        is_active: true,
      },
    ],
    workflow_sender_pool_members: [
      {
        id: "member-1",
        sender_pool_id: "pool-1",
        sender_value: "+15555550100",
        sender_label: "Austin Sender",
        weight: 1,
        status: "active",
      },
    ],
  });

  const exact = await routeWorkflowSender({
    workflow_id: "workflow-1",
    channel: "sms",
    context: { market: "austin_tx", state: "TX", language: "en" },
  }, { supabase });
  assert.equal(exact.ok, true);
  assert.equal(exact.tier, "exact_market");
  assert.equal(exact.member.id, "member-1");

  const blocked = await routeWorkflowSender({
    workflow_id: "workflow-1",
    channel: "sms",
    context: { market: "phoenix_az", state: "AZ", language: "en" },
  }, { supabase });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "unsafe_sender_fallback_blocked");
});

test("workflow dry-run renders send steps without sending and keeps live sends blocked", async () => {
  process.env.AUTOMATION_LIVE_SENDS_ENABLED = "false";
  process.env.WORKFLOW_LIVE_SENDS_ENABLED = "false";
  const supabase = createFakeSupabase();
  const workflow = await createWorkflow({
    name: "Dry Run Workflow",
    channel: "sms",
    workflow_type: "outbound",
    market_scope: ["austin_tx"],
    state_scope: ["TX"],
    language_scope: ["en"],
  }, { supabase });
  await createWorkflowStep(workflow.workflow_id, {
    label: "Owner Check",
    node_type: "send_sms",
    step_order: 10,
    actions: [{ action_type: "send_sms", dry_run: true, live_enabled: false }],
  }, { supabase });
  const set = await createWorkflowTemplateSet(workflow.workflow_id, {
    name: "Owner Check Templates",
    channel: "sms",
    language: "en",
  }, { supabase });
  const variant = await createWorkflowTemplateVariant(set.template_set_id, {
    variant_key: "a",
    body: "Hi {first_name}, {checking in|quick question} about {property_address}.",
    personalization_tokens: ["first_name", "property_address"],
  }, { supabase });
  await upsertWorkflowTemplateTranslation(variant.variant_id, {
    language: "es",
    translated_body: "Hola {first_name}, pregunta rápida sobre {property_address}.",
    translation_status: "pending",
  }, { supabase });
  const pool = await createWorkflowSenderPool(workflow.workflow_id, {
    name: "Austin SMS",
    channel: "sms",
    market_scope: ["austin_tx"],
    state_scope: ["TX"],
    language_scope: ["en"],
  }, { supabase });
  await createWorkflowSenderPoolMember(pool.sender_pool_id, {
    sender_value: "+15555550100",
    sender_label: "Austin Sender",
  }, { supabase });

  const dryRun = await dryRunWorkflow({
    workflow_id: workflow.workflow_id,
    context: {
      conversation_thread_id: "thread-1",
      first_name: "Jordan",
      property_address: "123 Main St",
      market: "austin_tx",
      state: "TX",
      language: "en",
    },
  }, { supabase });

  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.dry_run, true);
  assert.equal(dryRun.live_send_blocked, true);
  assert.equal(dryRun.no_outbound_messages_sent, true);
  const renderedSendStep = dryRun.steps.find((step) => step.rendered_template?.body);
  assert.ok(renderedSendStep);
  assert.match(renderedSendStep.rendered_template.body, /Jordan/);
  assert.equal(renderedSendStep.actions[0].live_send_blocked, true);

  const detail = await getWorkflow(workflow.workflow_id, { supabase });
  const translation = detail.template_sets
    .flatMap((templateSet) => templateSet.variants || [])
    .flatMap((templateVariant) => templateVariant.translations || [])
    .find((entry) => entry.language === "es");
  assert.ok(translation);
  assert.equal(translation.translation_status, "pending");
});
