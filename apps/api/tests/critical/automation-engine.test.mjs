import test from "node:test";
import assert from "node:assert/strict";

import { runAutomationEngine } from "@/lib/domain/automation/automation-engine.js";
import {
  handleTextgridDeliveryWebhook,
  __setTextgridDeliveryTestDeps,
  __resetTextgridDeliveryTestDeps,
} from "@/lib/flows/handle-textgrid-delivery.js";
import {
  appRefField,
  createPodioItem,
  textField,
} from "../helpers/test-helpers.js";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function clean(value) {
  return String(value ?? "").trim();
}

function createFakeSupabase(seed = {}, options = {}) {
  const rows = Object.fromEntries(
    Object.entries(seed).map(([table, tableRows]) => [table, tableRows.map(clone)])
  );
  let seq = 0;

  function ensureTable(table) {
    if (!rows[table]) rows[table] = [];
    return rows[table];
  }

  function newId(table) {
    seq += 1;
    return `${table}-${seq}`;
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
      this.values = null;
      this.patch = null;
      this.conflictKeys = [];
      this.limitCount = null;
      this.orderBy = null;
    }

    select() {
      if (!this.op) this.op = "select";
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
      const configured_error =
        options.errors?.[this.table]?.[this.op] ||
        options.errors?.[this.table]?.all ||
        null;
      if (configured_error) {
        return {
          data: single ? null : [],
          error: typeof configured_error === "string"
            ? { message: configured_error }
            : configured_error,
        };
      }

      const table = ensureTable(this.table);

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
            Object.assign(existing, row, { updated_at: row.updated_at || new Date().toISOString() });
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
        const matched = table.filter((row) => matches(row, this.filters));
        for (const row of matched) {
          for (const [key, value] of Object.entries(this.patch || {})) {
            if (value !== undefined) row[key] = value;
          }
          row.updated_at = row.updated_at || new Date().toISOString();
        }
        return { data: single ? matched[0] || null : matched, error: null };
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

function inboundEvent(message_body, overrides = {}) {
  return {
    event_type: "inbound_message_received",
    source: "test",
    dedupe_key: overrides.dedupe_key || `test-inbound:${message_body}`,
    conversation_thread_id: overrides.thread_key || "+15551234567",
    master_owner_id: "mo-1",
    prospect_id: "prospect-1",
    property_id: "property-1",
    phone_number_id: "phone-1",
    payload: {
      message_body,
      from_phone_number: "+15551234567",
      to_phone_number: "+15557654321",
      thread_key: overrides.thread_key || "+15551234567",
      classification: overrides.classification || {},
      ...overrides.payload,
    },
  };
}

test("automation engine: inbound STOP suppresses phone, cancels pending queue, and writes audit logs", async () => {
  const supabase = createFakeSupabase({
    send_queue: [
      {
        id: "queue-1",
        queue_status: "queued",
        to_phone_number: "+15551234567",
        master_owner_id: "mo-1",
      },
      {
        id: "queue-2",
        queue_status: "sent",
        to_phone_number: "+15551234567",
        master_owner_id: "mo-1",
      },
    ],
  });

  const result = await runAutomationEngine({
    event: inboundEvent("STOP"),
    supabaseClient: supabase,
  });

  assert.equal(result.ok, true);
  assert.equal(
    result.matched_rules.some((rule) => rule.rule_key === "suppression.stop_dnc"),
    true
  );
  assert.equal(supabase.rows.automation_suppressions.length, 1);
  assert.equal(supabase.rows.automation_suppressions[0].suppression_type, "opt_out");
  assert.equal(supabase.rows.send_queue.find((row) => row.id === "queue-1").queue_status, "cancelled");
  assert.equal(supabase.rows.send_queue.find((row) => row.id === "queue-2").queue_status, "sent");
  assert.ok(supabase.rows.automation_audit_log.length > 0);
});

test("automation engine: duplicate events do not duplicate actions", async () => {
  const supabase = createFakeSupabase({
    send_queue: [
      {
        id: "queue-1",
        queue_status: "queued",
        to_phone_number: "+15551234567",
        master_owner_id: "mo-1",
      },
    ],
  });

  const event = inboundEvent("unsubscribe", { dedupe_key: "same-event" });
  const first = await runAutomationEngine({ event, supabaseClient: supabase });
  const firstActionCount = supabase.rows.automation_actions.length;
  const firstSuppressionCount = supabase.rows.automation_suppressions.length;
  const second = await runAutomationEngine({ event, supabaseClient: supabase });

  assert.equal(first.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(supabase.rows.automation_actions.length, firstActionCount);
  assert.equal(supabase.rows.automation_suppressions.length, firstSuppressionCount);
});

test("automation engine: wrong number suppresses phone and cancels queue", async () => {
  const supabase = createFakeSupabase({
    send_queue: [
      {
        id: "queue-1",
        queue_status: "scheduled",
        to_phone_number: "+15551234567",
        master_owner_id: "mo-1",
      },
    ],
    phones: [{ id: "phone-1", canonical_e164: "+15551234567" }],
  });

  const result = await runAutomationEngine({
    event: inboundEvent("wrong number"),
    supabaseClient: supabase,
  });

  assert.equal(result.ok, true);
  assert.equal(supabase.rows.automation_suppressions[0].suppression_type, "wrong_number");
  assert.equal(supabase.rows.send_queue[0].queue_status, "cancelled");
  assert.equal(supabase.rows.phones[0].phone_contact_status, "wrong_number");
});

test("automation engine: asking price moves thread hot and urgent without sending", async () => {
  const supabase = createFakeSupabase();

  const result = await runAutomationEngine({
    event: inboundEvent("How much is your offer?"),
    supabaseClient: supabase,
  });

  const thread = supabase.rows.inbox_thread_state.find(
    (row) => row.thread_key === "+15551234567"
  );

  assert.equal(result.ok, true);
  assert.equal(thread.stage, "needs_offer");
  assert.equal(thread.priority, "urgent");
  assert.equal(thread.is_urgent, true);
  assert.equal(thread.metadata.automation_engine.lead_temperature, "hot");
  assert.equal((supabase.rows.send_queue || []).length, 0);
});

test("automation engine: delivered/no-reply plans one dry-run follow-up and no live outbound send", async () => {
  const supabase = createFakeSupabase();
  const event = {
    event_type: "outbound_message_delivered",
    source: "test",
    dedupe_key: "delivered-1",
    conversation_thread_id: "+15551234567",
    master_owner_id: "mo-1",
    phone_number_id: "phone-1",
    queue_item_id: "queue-1",
    payload: {
      thread_key: "+15551234567",
      to_phone_number: "+15551234567",
      provider_message_sid: "tg-1",
      has_reply_since_delivery: false,
    },
  };

  const first = await runAutomationEngine({ event, supabaseClient: supabase });
  const actionCount = supabase.rows.automation_actions.length;
  const second = await runAutomationEngine({ event, supabaseClient: supabase });

  const followupAction = supabase.rows.automation_actions.find(
    (action) => action.action_type === "schedule_follow_up"
  );

  assert.equal(first.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(followupAction.dry_run, true);
  assert.equal(followupAction.status, "completed");
  assert.equal(followupAction.result.planned, true);
  assert.equal(supabase.rows.automation_actions.length, actionCount);
  assert.equal((supabase.rows.send_queue || []).length, 0);
});

test("automation engine: duplicate queue failure does not duplicate alerts", async () => {
  const supabase = createFakeSupabase();
  const event = {
    event_type: "queue_item_failed",
    source: "test",
    dedupe_key: "queue-failure-1",
    conversation_thread_id: "+15551234567",
    queue_item_id: "queue-1",
    payload: {
      queue_item_id: "queue-1",
      queue_status: "failed",
      failed_reason: "carrier_blocked",
    },
  };

  const first = await runAutomationEngine({ event, supabaseClient: supabase });
  const alertCount = supabase.rows.ops_notifications.length;
  const actionCount = supabase.rows.automation_actions.length;
  const second = await runAutomationEngine({ event, supabaseClient: supabase });

  assert.equal(first.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(alertCount, 1);
  assert.equal(supabase.rows.ops_notifications.length, alertCount);
  assert.equal(supabase.rows.automation_actions.length, actionCount);
});

test("automation engine: replayed event skips duplicate action dedupe keys", async () => {
  const supabase = createFakeSupabase({
    send_queue: [
      {
        id: "queue-1",
        queue_status: "queued",
        to_phone_number: "+15551234567",
        master_owner_id: "mo-1",
      },
    ],
  });

  const first = await runAutomationEngine({
    event: inboundEvent("STOP", { dedupe_key: "stop-replay-1" }),
    supabaseClient: supabase,
  });
  const firstActionCount = supabase.rows.automation_actions.length;
  const replay = await runAutomationEngine({
    event: first.event,
    replay: true,
    supabaseClient: supabase,
  });

  const replayActions = replay.runs.flatMap((run) => run.actions || []);

  assert.equal(first.ok, true);
  assert.equal(replay.ok, true);
  assert.equal(supabase.rows.automation_actions.length, firstActionCount);
  assert.equal(replayActions.some((action) => action.duplicate === true), true);
});

test("automation engine: repeated suppression for the same phone upserts one active row", async () => {
  const supabase = createFakeSupabase();

  const first = await runAutomationEngine({
    event: inboundEvent("STOP", { dedupe_key: "stop-one" }),
    supabaseClient: supabase,
  });
  const second = await runAutomationEngine({
    event: inboundEvent("unsubscribe", { dedupe_key: "stop-two" }),
    supabaseClient: supabase,
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(supabase.rows.automation_suppressions.length, 1);
  assert.equal(supabase.rows.automation_suppressions[0].suppression_type, "opt_out");
});

test("automation engine: send-capable action is blocked by default", async () => {
  const previousAutomationGuard = process.env.AUTOMATION_LIVE_SENDS_ENABLED;
  const previousWorkflowGuard = process.env.WORKFLOW_LIVE_SENDS_ENABLED;
  process.env.AUTOMATION_LIVE_SENDS_ENABLED = "false";
  process.env.WORKFLOW_LIVE_SENDS_ENABLED = "false";

  try {
    const supabase = createFakeSupabase({
      automation_rules: [
        {
          id: "rule-send",
          rule_key: "test.send_sms_blocked",
          event_type: "inbound_message_received",
          status: "active",
          is_active: true,
          priority: 1,
          dry_run_default: false,
          condition: { matcher: "any_inbound_reply" },
          actions: [
            {
              action_type: "send_sms",
              live_enabled: true,
              params: { body: "This must never send" },
            },
          ],
        },
      ],
    });

    const result = await runAutomationEngine({
      event: inboundEvent("hello", { dedupe_key: "send-blocked-1" }),
      supabaseClient: supabase,
    });
    const action = supabase.rows.automation_actions.find((row) => row.action_type === "send_sms");

    assert.equal(result.ok, true);
    assert.equal(action.status, "skipped");
    assert.equal(action.live_enabled, true);
    assert.equal(action.result.live_send_blocked, true);
    assert.equal(action.result.reason, "send_action_type_not_supported");
    assert.equal((supabase.rows.send_queue || []).length, 0);
  } finally {
    if (previousAutomationGuard === undefined) delete process.env.AUTOMATION_LIVE_SENDS_ENABLED;
    else process.env.AUTOMATION_LIVE_SENDS_ENABLED = previousAutomationGuard;
    if (previousWorkflowGuard === undefined) delete process.env.WORKFLOW_LIVE_SENDS_ENABLED;
    else process.env.WORKFLOW_LIVE_SENDS_ENABLED = previousWorkflowGuard;
  }
});

test("automation engine: missing state target column writes skipped audit reason", async () => {
  const supabase = createFakeSupabase(
    {
      automation_rules: [
        {
          id: "rule-state",
          rule_key: "test.patch_state_missing_column",
          event_type: "inbound_message_received",
          status: "active",
          is_active: true,
          priority: 1,
          dry_run_default: false,
          condition: { matcher: "any_inbound_reply" },
          actions: [
            {
              action_type: "patch_thread_state",
              params: { status: "open", stage: "needs_offer" },
            },
          ],
        },
      ],
    },
    {
      errors: {
        inbox_thread_state: {
          upsert: { code: "42703", message: "column stage does not exist" },
        },
      },
    }
  );

  const result = await runAutomationEngine({
    event: inboundEvent("hello", { dedupe_key: "missing-state-column-1" }),
    supabaseClient: supabase,
  });
  const action = supabase.rows.automation_actions.find(
    (row) => row.action_type === "patch_thread_state"
  );
  const skippedAudit = supabase.rows.automation_audit_log.find(
    (row) =>
      row.status === "skipped" &&
      row.payload?.reason === "state_columns_pending_migration"
  );

  assert.equal(result.ok, true);
  assert.equal(action.status, "skipped");
  assert.equal(action.result.reason, "state_columns_pending_migration");
  assert.ok(skippedAudit);
});

test("automation engine: safe action aliases are dry-run or existing-table only", async () => {
  const supabase = createFakeSupabase({
    automation_rules: [
      {
        id: "rule-alias",
        rule_key: "test.safe_aliases",
        event_type: "inbound_message_received",
        status: "active",
        is_active: true,
        priority: 1,
        dry_run_default: false,
        condition: { matcher: "any_inbound_reply" },
        actions: [
          { action_type: "update_thread_status", params: { status: "open" } },
          { action_type: "update_stage", params: { stage: "needs_offer" } },
          { action_type: "update_temperature", params: { temperature: "hot" } },
          { action_type: "create_notification", params: { notification_type: "alias_test" } },
          { action_type: "dry_run_schedule_followup", params: { reason: "alias_test" } },
          { action_type: "mark_template_review", params: { template_id: "template-1" } },
          { action_type: "mark_template_kill", params: { template_id: "template-1" } },
          { action_type: "mark_template_scale", params: { template_id: "template-1" } },
          { action_type: "mark_sender_review", params: { reason: "alias_test" } },
          { action_type: "mark_sender_pause_candidate", params: { reason: "alias_test" } },
          { action_type: "trigger_deal_intelligence_refresh", params: { reason: "alias_test" } },
          { action_type: "trigger_comp_pull", params: { reason: "alias_test" } },
          { action_type: "trigger_buyer_match", params: { reason: "alias_test" } },
        ],
      },
    ],
  });

  const result = await runAutomationEngine({
    event: inboundEvent("hello", { dedupe_key: "safe-aliases-1" }),
    supabaseClient: supabase,
  });
  const thread = supabase.rows.inbox_thread_state.find(
    (row) => row.thread_key === "+15551234567"
  );
  const followupAction = supabase.rows.automation_actions.find(
    (row) => row.action_type === "dry_run_schedule_followup"
  );

  assert.equal(result.ok, true);
  assert.equal(thread.status, "open");
  assert.equal(thread.stage, "needs_offer");
  assert.equal(thread.metadata.automation_engine.lead_temperature, "hot");
  assert.equal(supabase.rows.ops_notifications.length, 1);
  assert.equal(followupAction.result.dry_run, true);
  assert.equal((supabase.rows.send_queue || []).length, 0);
  assert.equal(
    supabase.rows.automation_actions.filter((row) => row.status === "completed").length,
    13
  );
});

test("textgrid delivery webhook: automation emitter failure is non-blocking", async (t) => {
  t.after(() => {
    __resetTextgridDeliveryTestDeps();
  });

  const warnings = [];
  const outboundEvent = createPodioItem(901, {
    "message-id": textField("provider-auto-fail"),
    "text-2": textField("provider-auto-fail"),
    "master-owner": appRefField(201),
    "linked-seller": appRefField(301),
    "properties": appRefField(601),
    "phone-number": appRefField(401),
    "conversation": appRefField(701),
  });
  const queueItem = createPodioItem(123, {
    "master-owner": appRefField(201),
    "prospects": appRefField(301),
    "properties": appRefField(601),
    "phone-number": appRefField(401),
    "textgrid-number": appRefField(501),
  });

  __setTextgridDeliveryTestDeps({
    info: () => {},
    warn: (event, meta) => warnings.push({ event, meta }),
    findMessageEventItemsByProviderMessageId: async () => [outboundEvent],
    getItem: async (item_id) => (Number(item_id) === 123 ? queueItem : null),
    fetchAllItems: async () => [],
    updateItem: async () => {},
    updateMessageEventStatus: async () => {},
    findBestBrainMatch: async () => null,
    findLatestBrainByProspectId: async () => null,
    findLatestBrainByMasterOwnerId: async () => null,
    updatePhoneNumberItem: async () => {},
    updateBrainAfterDelivery: async () => {},
    mapTextgridFailureBucket: () => "Other",
    notifyDiscordOps: async () => {},
    emitAutomationEvent: async () => {
      throw new Error("automation insert failed");
    },
  });

  const result = await handleTextgridDeliveryWebhook({
    message_id: "provider-auto-fail",
    status: "delivered",
    client_reference_id: "queue-123",
  });

  assert.equal(result.ok, true);
  assert.equal(result.normalized_state, "Delivered");
  assert.equal(
    warnings.some((entry) => entry.event === "textgrid.delivery_automation_emit_failed"),
    true
  );
});
