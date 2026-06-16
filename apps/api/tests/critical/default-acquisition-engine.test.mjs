import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  scheduleDeliveryRetry,
} from "@/lib/domain/acquisition/delivery-retry-engine.js";
import {
  findAcquisitionContact,
  getOrCreateAcquisitionContact,
  recordOfferTarget,
  updateStage,
} from "@/lib/domain/acquisition/acquisition-contact-service.js";
import { ACQUISITION_EVENTS_TABLE } from "@/lib/domain/acquisition/acquisition-event-service.js";
import { ACQUISITION_RUNTIME_FLAGS } from "@/lib/domain/acquisition/acquisition-runtime-control.js";
import {
  ACQUISITION_STAGE_LIST,
  ACQUISITION_STAGES,
  isCanonicalAcquisitionStage,
  normalizeAcquisitionStage,
} from "@/lib/domain/acquisition/acquisition-stage-registry.js";
import {
  handleDeliveryReceipt,
} from "@/lib/domain/acquisition/delivery-receipt-handler.js";
import {
  dispatchInboundAcquisitionSms,
} from "@/lib/domain/acquisition/inbound-dispatcher.js";
import {
  resolveNoReplyFollowupTime,
  scheduleNoReplyFollowup,
} from "@/lib/domain/acquisition/no-reply-followup-scheduler.js";
import { processSendQueueItem } from "@/lib/domain/queue/process-send-queue.js";
import { syncDeliveryEvent } from "@/lib/supabase/sms-engine.js";

const NOW = "2026-06-15T15:00:00.000Z";

function getPath(row, column) {
  if (column.includes("->>")) {
    const [root, key] = column.split("->>");
    return row?.[root]?.[key] ?? null;
  }
  return row?.[column];
}

function makeMemorySupabase(seed = {}) {
  const tables = Object.fromEntries(
    Object.entries(seed).map(([table, rows]) => [
      table,
      rows.map((row) => ({ ...row })),
    ])
  );
  let sequence = 0;

  function rowsFor(table) {
    tables[table] ||= [];
    return tables[table];
  }

  class Query {
    constructor(table) {
      this.table = table;
      this.action = "select";
      this.payload = null;
      this.filters = [];
      this.selectOptions = {};
      this.rowLimit = null;
    }

    select(_columns = "*", options = {}) {
      this.selectOptions = options || {};
      return this;
    }

    insert(payload) {
      this.action = "insert";
      this.payload = payload;
      return this;
    }

    update(payload) {
      this.action = "update";
      this.payload = payload;
      return this;
    }

    upsert(payload, options = {}) {
      this.action = "upsert";
      this.payload = payload;
      this.upsertOptions = options;
      return this;
    }

    eq(column, value) {
      this.filters.push((row) => getPath(row, column) === value);
      return this;
    }

    is(column, value) {
      this.filters.push((row) => getPath(row, column) === value);
      return this;
    }

    in(column, values) {
      this.filters.push((row) => values.includes(getPath(row, column)));
      return this;
    }

    or(expression) {
      const clauses = String(expression)
        .split(",")
        .map((clause) => {
          const [column, operator, ...valueParts] = clause.split(".");
          return {
            column,
            operator,
            value: valueParts.join("."),
          };
        });
      this.filters.push((row) =>
        clauses.some(
          ({ column, operator, value }) =>
            operator === "eq" && String(getPath(row, column) ?? "") === value
        )
      );
      return this;
    }

    gte(column, value) {
      this.filters.push((row) => String(getPath(row, column) || "") >= String(value));
      return this;
    }

    limit(value) {
      this.rowLimit = Number(value);
      return this;
    }

    order() {
      return this;
    }

    matchingRows() {
      let rows = rowsFor(this.table).filter((row) =>
        this.filters.every((filter) => filter(row))
      );
      if (Number.isFinite(this.rowLimit)) rows = rows.slice(0, this.rowLimit);
      return rows;
    }

    execute() {
      if (this.action === "insert") {
        const payloads = Array.isArray(this.payload) ? this.payload : [this.payload];
        if (this.table === "acquisition_events") {
          const duplicate = payloads.some((payload) =>
            rowsFor(this.table).some(
              (row) =>
                row.dedupe_key === payload.dedupe_key ||
                (payload.event_type === "sms.delivery_receipt_received" &&
                  row.event_type === payload.event_type &&
                  row.provider_message_id === payload.provider_message_id &&
                  row.provider_status === payload.provider_status)
            )
          );
          if (duplicate) {
            return {
              data: null,
              error: { code: "23505", message: "duplicate acquisition event" },
            };
          }
        }
        const inserted = payloads.map((payload) => {
          const row = {
            id: payload.id || `${this.table}-${++sequence}`,
            created_at: payload.created_at || NOW,
            ...payload,
          };
          rowsFor(this.table).push(row);
          return row;
        });
        return { data: Array.isArray(this.payload) ? inserted : inserted[0], error: null };
      }

      if (this.action === "update") {
        const matched = this.matchingRows();
        for (const row of matched) Object.assign(row, this.payload);
        return { data: matched.map((row) => ({ ...row })), error: null };
      }

      if (this.action === "upsert") {
        const payloads = Array.isArray(this.payload) ? this.payload : [this.payload];
        const conflictColumns = String(this.upsertOptions?.onConflict || "id").split(",");
        const upserted = payloads.map((payload) => {
          const existing = rowsFor(this.table).find((row) =>
            conflictColumns.every((column) => row[column] === payload[column])
          );
          if (existing) {
            Object.assign(existing, payload);
            return existing;
          }
          const row = { id: payload.id || `${this.table}-${++sequence}`, ...payload };
          rowsFor(this.table).push(row);
          return row;
        });
        return { data: Array.isArray(this.payload) ? upserted : upserted[0], error: null };
      }

      const matched = this.matchingRows();
      return {
        data: this.selectOptions.head ? null : matched.map((row) => ({ ...row })),
        count: this.selectOptions.count ? matched.length : null,
        error: null,
      };
    }

    maybeSingle() {
      const result = this.execute();
      return Promise.resolve({
        ...result,
        data: Array.isArray(result.data) ? result.data[0] || null : result.data,
      });
    }

    single() {
      return this.maybeSingle();
    }

    then(resolve, reject) {
      return Promise.resolve(this.execute()).then(resolve, reject);
    }
  }

  return {
    tables,
    from(table) {
      return new Query(table);
    },
  };
}

function baseContact(overrides = {}) {
  return {
    id: "contact-1",
    phone: "+15551230001",
    canonical_e164: "+15551230001",
    property_id: "property-1",
    master_owner_id: "owner-1",
    thread_id: "+15551230001",
    campaign_id: "campaign-1",
    current_stage: "ownership_check",
    stage_updated_at: NOW,
    contact_temperature: "cold",
    priority: "normal",
    ownership_confirmed: false,
    is_opt_out: false,
    is_wrong_number: false,
    is_hostile: false,
    last_delivered_at: null,
    last_inbound_at: null,
    seller_asking_price: null,
    internal_target_price: null,
    offer_ratio: null,
    property_type: null,
    unit_count: null,
    condition_summary: null,
    retry_count: 0,
    tried_template_ids: [],
    next_followup_at: null,
    automation_status: "active",
    metadata: {},
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function template(id, useCase, body = `Message ${id}`) {
  return {
    id,
    item_id: id,
    template_id: id,
    use_case: useCase,
    template_body: body,
    text: body,
    source: "supabase",
  };
}

function makeDeps(supabase, templates = []) {
  const acquisitionRuntimeFlags = Object.fromEntries(
    Object.values(ACQUISITION_RUNTIME_FLAGS).map((key) => [key, true])
  );
  return {
    supabase,
    now: NOW,
    acquisitionRuntimeFlags,
    random: () => 0.5,
    safetyCheck: async () => ({ ok: true }),
    loadTemplates: async ({ use_case }) =>
      templates.filter((candidate) => candidate.use_case === use_case),
    insertQueueRow: async (payload) => {
      const row = {
        id: `queue-${supabase.tables.send_queue.length + 1}`,
        created_at: NOW,
        ...payload,
      };
      supabase.tables.send_queue.push(row);
      return {
        ok: true,
        queue_row_id: row.id,
        queue_id: row.queue_id,
        queue_key: row.queue_key,
        raw: row,
      };
    },
    updateInboxState: async () => ({ ok: true }),
  };
}

function runtimeFlags(overrides = {}) {
  return {
    ...Object.fromEntries(
      Object.values(ACQUISITION_RUNTIME_FLAGS).map((key) => [key, true])
    ),
    ...overrides,
  };
}

test("failed SMS schedules a retry with a different template", async () => {
  const contact = baseContact();
  const failed = {
    id: "failed-1",
    queue_status: "failed",
    to_phone_number: contact.canonical_e164,
    from_phone_number: "+15557654321",
    master_owner_id: contact.master_owner_id,
    property_id: contact.property_id,
    thread_key: contact.thread_id,
    current_stage: contact.current_stage,
    use_case_template: "ownership_check",
    template_id: "template-1",
    timezone: "America/Chicago",
    created_at: NOW,
    metadata: {},
  };
  const supabase = makeMemorySupabase({
    acquisition_contacts: [contact],
    send_queue: [failed],
    acquisition_events: [],
  });
  const deps = makeDeps(supabase, [
    template("template-1", "ownership_check"),
    template("template-2", "ownership_check"),
  ]);

  const result = await scheduleDeliveryRetry(
    { queue_row: failed },
    { failure_reason: "carrier_failed", now: NOW },
    deps
  );

  assert.equal(result.ok, true);
  assert.equal(result.retry_count, 1);
  assert.equal(result.template_id, "template-2");
  assert.equal(supabase.tables.send_queue.at(-1).template_id, "template-2");
  assert.equal(
    supabase.tables.send_queue.at(-1).metadata.acquisition_managed,
    true
  );
  assert.deepEqual(
    supabase.tables.acquisition_contacts[0].tried_template_ids,
    ["template-1", "template-2"]
  );
  assert.ok(
    supabase.tables.acquisition_events.some(
      (event) => event.event_type === "sms.delivery_retry_scheduled"
    )
  );
});

test("delivery retry stops on the third failed delivery", async () => {
  const contact = baseContact({
    retry_count: 2,
    tried_template_ids: ["template-1", "template-2", "template-3"],
  });
  const failed = {
    id: "failed-3",
    queue_status: "failed",
    to_phone_number: contact.canonical_e164,
    template_id: "template-3",
    current_stage: "ownership_check",
    use_case_template: "ownership_check",
    created_at: NOW,
    metadata: { acquisition_retry_count: 2 },
  };
  const supabase = makeMemorySupabase({
    acquisition_contacts: [contact],
    send_queue: [failed],
    acquisition_events: [],
  });

  const result = await scheduleDeliveryRetry(
    { queue_row: failed },
    { failure_reason: "delivery_failed" },
    makeDeps(supabase, [])
  );

  assert.equal(result.exhausted, true);
  assert.equal(supabase.tables.send_queue.length, 1);
  assert.equal(
    supabase.tables.acquisition_contacts[0].automation_status,
    "terminal_failed"
  );
  assert.deepEqual(
    supabase.tables.acquisition_events
      .filter((event) => event.event_type !== "sms.delivery_receipt_received")
      .map((event) => event.event_type),
    ["sms.delivery_retry_exhausted", "sms.undeliverable"]
  );
});

test("retry count contract allows two retries and terminals every later failure", async () => {
  const scenarios = [
    { retry_count: 0, expected_retry_count: 1, exhausted: false },
    { retry_count: 1, expected_retry_count: 2, exhausted: false },
    { retry_count: 2, expected_retry_count: 3, exhausted: true },
    { retry_count: 3, expected_retry_count: 3, exhausted: true },
    { retry_count: 5, expected_retry_count: 3, exhausted: true },
  ];

  for (const scenario of scenarios) {
    const contact = baseContact({
      retry_count: scenario.retry_count,
      tried_template_ids: ["template-1"],
    });
    const failed = {
      id: `failed-count-${scenario.retry_count}`,
      queue_status: "failed",
      to_phone_number: contact.canonical_e164,
      property_id: contact.property_id,
      current_stage: ACQUISITION_STAGES.OWNERSHIP_CHECK,
      use_case_template: "ownership_check",
      template_id: "template-1",
      created_at: NOW,
      metadata: { acquisition_retry_count: scenario.retry_count },
    };
    const supabase = makeMemorySupabase({
      acquisition_contacts: [contact],
      send_queue: [failed],
      acquisition_events: [],
    });
    const result = await scheduleDeliveryRetry(
      { queue_row: failed },
      { failure_reason: "carrier_failed" },
      makeDeps(supabase, [
        template("template-1", "ownership_check"),
        template("template-2", "ownership_check"),
      ])
    );

    assert.equal(result.exhausted === true, scenario.exhausted);
    assert.equal(result.retry_count, scenario.expected_retry_count);
    assert.equal(
      supabase.tables.send_queue.length,
      scenario.exhausted ? 1 : 2
    );
  }
});

test("duplicate failed delivery receipt creates only one retry row", async () => {
  const contact = baseContact();
  const failed = {
    id: "failed-duplicate-1",
    provider_message_id: "provider-failed-duplicate-1",
    queue_status: "failed_transport",
    to_phone_number: contact.canonical_e164,
    property_id: contact.property_id,
    current_stage: ACQUISITION_STAGES.OWNERSHIP_CHECK,
    use_case_template: "ownership_check",
    template_id: "template-1",
    created_at: NOW,
    metadata: { acquisition_managed: true },
  };
  const supabase = makeMemorySupabase({
    acquisition_contacts: [contact],
    send_queue: [failed],
    acquisition_events: [],
  });
  const deps = makeDeps(supabase, [
    template("template-1", "ownership_check"),
    template("template-2", "ownership_check"),
  ]);
  const metadata = {
    delivery_status: "failed",
    provider_message_id: failed.provider_message_id,
    failure_reason: "carrier_failed",
  };

  const first = await handleDeliveryReceipt({ queue_row: failed }, metadata, deps);
  const duplicate = await handleDeliveryReceipt(
    { queue_row: failed },
    metadata,
    deps
  );

  assert.equal(first.retry_scheduled, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.reason, "duplicate_delivery_receipt");
  assert.equal(supabase.tables.send_queue.length, 2);
  assert.equal(
    supabase.tables.acquisition_events.filter(
      (event) => event.event_type === "sms.delivery_retry_scheduled"
    ).length,
    1
  );
});

test("duplicate delivered receipt creates no duplicate events or follow-up", async () => {
  const contact = baseContact();
  const delivered = {
    id: "delivered-duplicate-1",
    provider_message_id: "provider-delivered-duplicate-1",
    queue_status: "delivered",
    delivered_at: NOW,
    to_phone_number: contact.canonical_e164,
    from_phone_number: "+15557654321",
    property_id: contact.property_id,
    current_stage: ACQUISITION_STAGES.OWNERSHIP_CHECK,
    use_case_template: "ownership_check",
    template_id: "template-1",
    timezone: "America/Chicago",
    created_at: "2026-06-15T14:55:00.000Z",
    metadata: { acquisition_managed: true },
  };
  const supabase = makeMemorySupabase({
    acquisition_contacts: [contact],
    send_queue: [delivered],
    acquisition_events: [],
  });
  const deps = makeDeps(supabase, [
    template("followup-1", "ownership_check_follow_up"),
  ]);
  const metadata = {
    delivery_status: "delivered",
    delivered_at: NOW,
    provider_message_id: delivered.provider_message_id,
  };

  const first = await handleDeliveryReceipt({ queue_row: delivered }, metadata, deps);
  const duplicate = await handleDeliveryReceipt(
    { queue_row: delivered },
    metadata,
    deps
  );

  assert.equal(first.delivered, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(supabase.tables.send_queue.length, 2);
  assert.equal(
    supabase.tables.acquisition_events.filter(
      (event) => event.event_type === "sms.delivery_confirmed"
    ).length,
    1
  );
  assert.equal(
    supabase.tables.acquisition_events.filter(
      (event) => event.event_type === "lead.first_contact_confirmed"
    ).length,
    1
  );
});

test("delivered status records timestamp and schedules a no-reply follow-up", async () => {
  const contact = baseContact({ retry_count: 2, tried_template_ids: ["template-1"] });
  const delivered = {
    id: "delivered-1",
    queue_status: "delivered",
    delivered_at: NOW,
    to_phone_number: contact.canonical_e164,
    from_phone_number: "+15557654321",
    master_owner_id: contact.master_owner_id,
    property_id: contact.property_id,
    thread_key: contact.thread_id,
    current_stage: "ownership_check",
    template_id: "template-1",
    use_case_template: "ownership_check",
    timezone: "America/Chicago",
    created_at: "2026-06-15T14:55:00.000Z",
    metadata: {},
  };
  const supabase = makeMemorySupabase({
    acquisition_contacts: [contact],
    send_queue: [delivered],
    acquisition_events: [],
  });
  const deps = makeDeps(supabase, [
    template("followup-1", "ownership_check_follow_up"),
  ]);

  const result = await handleDeliveryReceipt(
    { queue_row: delivered },
    {
      delivery_status: "delivered",
      delivered_at: NOW,
      provider_message_id: "delivered-provider-1",
    },
    deps
  );

  const stored = supabase.tables.acquisition_contacts[0];
  assert.equal(result.ok, true);
  assert.equal(stored.last_delivered_at, NOW);
  assert.equal(stored.retry_count, 0);
  assert.deepEqual(stored.tried_template_ids, []);
  assert.equal(result.first_successful_contact, true);
  assert.equal(result.followup.followup_created, true);
  assert.equal(
    supabase.tables.send_queue.at(-1).metadata.acquisition_managed,
    true
  );
  assert.ok(stored.next_followup_at);
  assert.ok(
    supabase.tables.acquisition_events.some(
      (event) => event.event_type === "lead.first_contact_confirmed"
    )
  );
});

test("late delivered receipt does not schedule after seller already replied", async () => {
  const contact = baseContact({
    last_inbound_at: "2026-06-15T15:05:00.000Z",
  });
  const delivered = {
    id: "delivered-after-reply",
    queue_status: "delivered",
    delivered_at: "2026-06-15T15:10:00.000Z",
    sent_at: "2026-06-15T15:00:00.000Z",
    to_phone_number: contact.canonical_e164,
    from_phone_number: "+15557654321",
    master_owner_id: contact.master_owner_id,
    property_id: contact.property_id,
    thread_key: contact.thread_id,
    current_stage: "ownership_check",
    template_id: "template-1",
    use_case_template: "ownership_check",
    timezone: "America/Chicago",
    created_at: "2026-06-15T14:55:00.000Z",
    metadata: {},
  };
  const supabase = makeMemorySupabase({
    acquisition_contacts: [contact],
    send_queue: [delivered],
    acquisition_events: [],
  });

  const result = await handleDeliveryReceipt(
    { queue_row: delivered },
    {
      delivery_status: "delivered",
      delivered_at: delivered.delivered_at,
      provider_message_id: "delivered-provider-after-reply",
    },
    makeDeps(supabase, [template("followup-1", "ownership_check_follow_up")])
  );

  assert.equal(result.seller_already_replied, true);
  assert.equal(result.followup.reason, "seller_already_replied");
  assert.equal(supabase.tables.send_queue.length, 1);
});

test("STOP, wrong-number, and hostile replies cancel every active queue status", async () => {
  const activeStatuses = [
    "scheduled",
    "queued",
    "ready",
    "pending",
    "approved",
    "processing",
    "sending",
  ];
  const scenarios = [
    { message: "STOP", flag: "is_opt_out" },
    { message: "wrong number", flag: "is_wrong_number" },
    { message: "I am calling my lawyer", flag: "is_hostile" },
  ];

  for (const [scenarioIndex, scenario] of scenarios.entries()) {
    const contact = baseContact({ id: `contact-${scenarioIndex + 1}` });
    const supabase = makeMemorySupabase({
      acquisition_contacts: [contact],
      send_queue: [
        ...activeStatuses.map((queueStatus, index) => ({
          id: `${scenarioIndex}-${index}`,
          queue_status: queueStatus,
          to_phone_number: contact.canonical_e164,
          metadata: {},
        })),
        {
          id: `${scenarioIndex}-delivered`,
          queue_status: "delivered",
          to_phone_number: contact.canonical_e164,
          metadata: {},
        },
      ],
      acquisition_events: [],
      phones: [{ id: "phone-1", canonical_e164: contact.canonical_e164 }],
    });
    const deps = {
      ...makeDeps(supabase),
      classify: async () => {
        throw new Error("hard compliance guard must run before classifier");
      },
    };

    const result = await dispatchInboundAcquisitionSms(
      {
        message_id: `inbound-compliance-${scenarioIndex}`,
        message_body: scenario.message,
        phone: contact.canonical_e164,
        property_id: contact.property_id,
        master_owner_id: contact.master_owner_id,
      },
      {},
      deps
    );

    assert.equal(result.ok, true);
    assert.equal(supabase.tables.acquisition_contacts[0][scenario.flag], true);
    assert.equal(result.cancelled_count, activeStatuses.length);
    assert.ok(
      supabase.tables.send_queue
        .filter((row) => row.id !== `${scenarioIndex}-delivered`)
        .every((row) => row.queue_status === "cancelled")
    );
    assert.equal(
      supabase.tables.send_queue.find(
        (row) => row.id === `${scenarioIndex}-delivered`
      ).queue_status,
      "delivered"
    );
  }
});

test("ownership confirmation updates state and advances to consider_selling", async () => {
  const contact = baseContact();
  const supabase = makeMemorySupabase({
    acquisition_contacts: [contact],
    send_queue: [],
    acquisition_events: [],
  });
  const deps = {
    ...makeDeps(supabase, [
      template("selling-followup-1", "consider_selling_follow_up"),
    ]),
    classify: async () => ({
      primary_intent: "ownership_confirmed",
      confidence: 0.95,
      motivation_score: 75,
      seller_state: { ownership_confirmed: true },
    }),
  };

  const result = await dispatchInboundAcquisitionSms(
    {
      message_id: "inbound-owner-1",
      message_body: "Yes, I still own it",
      phone: contact.canonical_e164,
      inbound_to: "+15557654321",
      property_id: contact.property_id,
      master_owner_id: contact.master_owner_id,
      current_stage: "ownership_check",
      timezone: "America/Chicago",
    },
    {
      response_managed_externally: true,
      schedule_followup: true,
    },
    deps
  );

  const stored = supabase.tables.acquisition_contacts[0];
  assert.equal(result.stage_after, "consider_selling");
  assert.equal(stored.ownership_confirmed, true);
  assert.equal(stored.priority, "high");
  assert.equal(stored.contact_temperature, "hot");
  assert.equal(result.followup, null);
  assert.equal(supabase.tables.send_queue.length, 0);
});

test("explicit review requirements do not schedule automated follow-ups", async () => {
  const scenarios = [
    { needs_review: true },
    { manual_review: true },
    { safety_tier: "review" },
  ];

  for (const [index, reviewMetadata] of scenarios.entries()) {
    const contact = baseContact({ id: `review-contact-${index}` });
    const supabase = makeMemorySupabase({
      acquisition_contacts: [contact],
      send_queue: [],
      acquisition_events: [],
    });
    const deps = {
      ...makeDeps(supabase),
      classify: async () => ({
        primary_intent: "ownership_confirmed",
        confidence: 0.95,
      }),
    };

    const result = await dispatchInboundAcquisitionSms(
      {
        message_id: `inbound-review-${index}`,
        message_body: "Yes, I own it",
        phone: contact.canonical_e164,
        property_id: contact.property_id,
        master_owner_id: contact.master_owner_id,
        current_stage: "ownership_check",
      },
      { ...reviewMetadata, schedule_followup: true },
      deps
    );

    assert.equal(result.needs_review, true);
    assert.equal(result.safety_tier, "review");
    assert.equal(result.followup, null);
    assert.equal(supabase.tables.send_queue.length, 0);
    assert.equal(
      supabase.tables.acquisition_contacts[0].automation_status,
      "needs_review"
    );
  }
});

test("delivery webhook runs acquisition handling only for marked queue rows", async () => {
  const queueRows = [
    {
      id: "manual-row",
      provider_message_id: "manual-sid",
      queue_status: "sent",
      to_phone_number: "+15551230011",
      metadata: { source: "manual_inbox" },
    },
    {
      id: "workflow-row",
      provider_message_id: "workflow-sid",
      queue_status: "sent",
      to_phone_number: "+15551230012",
      metadata: { source: "workflow_v2" },
    },
    {
      id: "legacy-row",
      provider_message_id: "legacy-sid",
      queue_status: "sent",
      to_phone_number: "+15551230013",
      metadata: {},
    },
  ];
  const supabase = makeMemorySupabase({
    acquisition_contacts: [],
    message_events: [],
    send_queue: queueRows,
    acquisition_events: [],
  });
  let acquisitionHandlerCalls = 0;

  for (const [index, row] of queueRows.entries()) {
    await syncDeliveryEvent(
      {
        message_id: row.provider_message_id,
        status: index === 1 ? "failed" : "delivered",
        error_message: index === 1 ? "carrier_failed" : null,
      },
      {
        supabase,
        now: NOW,
        handleAcquisitionDeliveryReceipt: async () => {
          acquisitionHandlerCalls += 1;
        },
      }
    );
  }

  assert.equal(acquisitionHandlerCalls, 0);

  const managedRow = {
    id: "acquisition-row",
    provider_message_id: "acquisition-sid",
    queue_status: "sent",
    to_phone_number: "+15551230014",
    metadata: {
      source: "campaign_launch_execution",
      acquisition_managed: true,
    },
  };
  supabase.tables.send_queue.push(managedRow);
  await syncDeliveryEvent(
    {
      message_id: managedRow.provider_message_id,
      status: "delivered",
    },
    {
      supabase,
      now: NOW,
      handleAcquisitionDeliveryReceipt: async () => {
        acquisitionHandlerCalls += 1;
      },
    }
  );

  assert.equal(acquisitionHandlerCalls, 1);
  assert.equal(supabase.tables.acquisition_contacts.length, 0);
  assert.equal(supabase.tables.send_queue.length, queueRows.length + 1);
  assert.equal(supabase.tables.acquisition_events.length, 0);
});

test("phone-only lookup rejects contacts spanning multiple properties", async () => {
  const phone = "+15551230021";
  const supabase = makeMemorySupabase({
    acquisition_contacts: [
      baseContact({
        id: "contact-property-1",
        phone,
        canonical_e164: phone,
        property_id: "property-1",
      }),
      baseContact({
        id: "contact-property-2",
        phone,
        canonical_e164: phone,
        property_id: "property-2",
      }),
    ],
  });
  const deps = { supabase, now: NOW };

  const found = await findAcquisitionContact({ phone }, deps);
  assert.equal(found.ok, false);
  assert.equal(found.status, 409);
  assert.equal(found.error, "ambiguous_contact");

  const created = await getOrCreateAcquisitionContact({ phone }, deps);
  assert.equal(created.ok, false);
  assert.equal(created.error, "ambiguous_contact");
  assert.equal(supabase.tables.acquisition_contacts.length, 2);
});

test("stage 2 positive response advances to asking_price", async () => {
  const contact = baseContact({ current_stage: "consider_selling" });
  const supabase = makeMemorySupabase({
    acquisition_contacts: [contact],
    send_queue: [],
    acquisition_events: [],
  });
  const deps = {
    ...makeDeps(supabase),
    classify: async () => ({
      primary_intent: "seller_interested",
      confidence: 0.93,
      motivation_score: 82,
    }),
  };

  const result = await dispatchInboundAcquisitionSms(
    {
      message_id: "inbound-interest-1",
      message_body: "I would consider selling",
      phone: contact.canonical_e164,
      property_id: contact.property_id,
      master_owner_id: contact.master_owner_id,
      current_stage: "consider_selling",
    },
    { response_managed_externally: true, schedule_followup: false },
    deps
  );

  assert.equal(result.stage_after, "asking_price");
  assert.equal(
    supabase.tables.acquisition_contacts[0].current_stage,
    "asking_price"
  );
});

test("asking price is extracted, stored, and routed to condition review", async () => {
  const contact = baseContact({ current_stage: "asking_price" });
  const supabase = makeMemorySupabase({
    acquisition_contacts: [contact],
    send_queue: [],
    acquisition_events: [],
  });
  const deps = {
    ...makeDeps(supabase),
    classify: async () => ({
      primary_intent: "asking_price_provided",
      confidence: 0.91,
      seller_state: { price_mentioned: 250000 },
    }),
  };

  const result = await dispatchInboundAcquisitionSms(
    {
      message_id: "inbound-price-1",
      message_body: "I want $250,000 for it",
      phone: contact.canonical_e164,
      property_id: contact.property_id,
      master_owner_id: contact.master_owner_id,
      current_stage: "asking_price",
    },
    { response_managed_externally: true, schedule_followup: false },
    deps
  );

  assert.equal(result.stage_after, "condition");
  assert.equal(
    supabase.tables.acquisition_contacts[0].seller_asking_price,
    250000
  );
});

test("stage 2 follow-up uses a randomized 16-20 hour business window", () => {
  const timing = resolveNoReplyFollowupTime({
    stage: "consider_selling",
    timezone: "America/Chicago",
    now: new Date(NOW),
    random: () => 0.5,
  });

  assert.equal(timing.sampled_delay_hours, 18);
  const local = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    weekday: "short",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timing.scheduled_for));
  const parts = Object.fromEntries(local.map((part) => [part.type, part.value]));
  assert.ok(!["Sat", "Sun"].includes(parts.weekday));
  assert.ok(Number(parts.hour) >= 9 && Number(parts.hour) < 18);
});

test("every acquisition audit event includes the decision contract", async () => {
  const contact = baseContact();
  const supabase = makeMemorySupabase({
    acquisition_contacts: [contact],
    send_queue: [],
    acquisition_events: [],
  });
  const deps = {
    ...makeDeps(supabase),
    classify: async () => ({
      primary_intent: "seller_interested",
      confidence: 0.94,
    }),
  };

  await dispatchInboundAcquisitionSms(
    {
      message_id: "inbound-audit-1",
      message_body: "I am open to selling",
      phone: contact.canonical_e164,
      property_id: contact.property_id,
      master_owner_id: contact.master_owner_id,
    },
    { response_managed_externally: true, schedule_followup: false },
    deps
  );

  assert.ok(supabase.tables.acquisition_events.length > 0);
  for (const event of supabase.tables.acquisition_events) {
    assert.ok("input_context" in event.payload);
    assert.ok("action_taken" in event.payload);
    assert.ok("selected_stage" in event.payload);
    assert.ok("selected_template" in event.payload);
    assert.ok("selected_use_case" in event.payload);
    assert.ok("classifier_output" in event.payload);
    assert.ok("reason" in event.payload);
    assert.ok("confidence" in event.payload);
    assert.ok("next_scheduled_action" in event.payload);
  }
});

test("acquisition runtime controls fail closed at every mutation boundary", async () => {
  const engineOff = makeMemorySupabase({
    acquisition_contacts: [],
    acquisition_events: [],
  });
  const createResult = await getOrCreateAcquisitionContact(
    { phone: "+15551230101", property_id: "property-engine-off" },
    {
      ...makeDeps(engineOff),
      acquisitionRuntimeFlags: runtimeFlags({
        [ACQUISITION_RUNTIME_FLAGS.ENGINE]: false,
      }),
    }
  );
  assert.equal(createResult.reason, "acquisition_runtime_disabled");
  assert.equal(engineOff.tables.acquisition_contacts.length, 0);

  const retryContact = baseContact({ id: "contact-retry-off" });
  const retryRow = {
    id: "retry-off-row",
    queue_status: "failed",
    to_phone_number: retryContact.canonical_e164,
    property_id: retryContact.property_id,
    current_stage: retryContact.current_stage,
    use_case_template: "ownership_check",
    template_id: "template-1",
    metadata: {},
  };
  const retryOff = makeMemorySupabase({
    acquisition_contacts: [retryContact],
    send_queue: [retryRow],
    acquisition_events: [],
  });
  const retryResult = await scheduleDeliveryRetry(
    { queue_row: retryRow },
    {},
    {
      ...makeDeps(retryOff, [template("template-2", "ownership_check")]),
      acquisitionRuntimeFlags: runtimeFlags({
        [ACQUISITION_RUNTIME_FLAGS.RETRY]: false,
      }),
    }
  );
  assert.equal(retryResult.reason, "acquisition_runtime_disabled");
  assert.equal(retryOff.tables.send_queue.length, 1);

  const followupContact = baseContact({ id: "contact-followup-off" });
  const followupOff = makeMemorySupabase({
    acquisition_contacts: [followupContact],
    send_queue: [],
    acquisition_events: [],
  });
  const followupResult = await scheduleNoReplyFollowup(
    { contact: followupContact },
    {},
    {
      ...makeDeps(followupOff, [
        template("followup-disabled", "ownership_check_follow_up"),
      ]),
      acquisitionRuntimeFlags: runtimeFlags({
        [ACQUISITION_RUNTIME_FLAGS.FOLLOWUP]: false,
      }),
    }
  );
  assert.equal(followupResult.reason, "acquisition_runtime_disabled");
  assert.equal(followupOff.tables.send_queue.length, 0);

  const inboundOff = makeMemorySupabase({
    acquisition_contacts: [],
    send_queue: [],
    acquisition_events: [],
  });
  const inboundResult = await dispatchInboundAcquisitionSms(
    {
      message_id: "inbound-disabled",
      message_body: "Yes, I own it",
      phone: "+15551230102",
      property_id: "property-inbound-off",
    },
    {},
    {
      ...makeDeps(inboundOff),
      acquisitionRuntimeFlags: runtimeFlags({
        [ACQUISITION_RUNTIME_FLAGS.INBOUND_DISPATCH]: false,
      }),
    }
  );
  assert.equal(inboundResult.reason, "acquisition_runtime_disabled");
  assert.equal(inboundOff.tables.acquisition_contacts.length, 0);

  const offerContact = baseContact({ id: "contact-offer-off" });
  const offerOff = makeMemorySupabase({
    acquisition_contacts: [offerContact],
  });
  const offerResult = await recordOfferTarget(
    offerContact.id,
    125000,
    {},
    {
      ...makeDeps(offerOff),
      acquisitionRuntimeFlags: runtimeFlags({
        [ACQUISITION_RUNTIME_FLAGS.OFFER_ENGINE]: false,
      }),
    }
  );
  assert.equal(offerResult.reason, "acquisition_runtime_disabled");
  assert.equal(offerOff.tables.acquisition_contacts[0].internal_target_price, null);
});

test("disabled acquisition controls also block already-scheduled queue rows", async () => {
  const rows = [
    {
      id: "queued-retry-disabled",
      queue_status: "scheduled",
      message_body: "retry",
      to_phone_number: "+15551230111",
      from_phone_number: "+15557654321",
      metadata: {
        acquisition_managed: true,
        source: "default_acquisition_delivery_retry",
        acquisition_retry_count: 1,
      },
      disabled_flag: ACQUISITION_RUNTIME_FLAGS.RETRY,
    },
    {
      id: "queued-followup-disabled",
      queue_status: "scheduled",
      message_body: "followup",
      to_phone_number: "+15551230112",
      from_phone_number: "+15557654321",
      metadata: {
        acquisition_managed: true,
        acquisition_followup: "true",
      },
      disabled_flag: ACQUISITION_RUNTIME_FLAGS.FOLLOWUP,
    },
    {
      id: "queued-inbound-disabled",
      queue_status: "queued",
      message_body: "auto reply",
      message_type: "auto_reply",
      to_phone_number: "+15551230113",
      from_phone_number: "+15557654321",
      metadata: {
        acquisition_managed: true,
        source: "default_acquisition_inbound_dispatcher",
      },
      disabled_flag: ACQUISITION_RUNTIME_FLAGS.INBOUND_DISPATCH,
    },
  ];

  for (const row of rows) {
    let sendCalls = 0;
    const result = await processSendQueueItem(row, {
      getSystemValue: async () => null,
      sendTextgridSMS: async () => {
        sendCalls += 1;
        return { ok: true };
      },
      acquisitionRuntimeFlags: runtimeFlags({
        [row.disabled_flag]: false,
      }),
    });
    assert.equal(result.reason, "acquisition_runtime_disabled");
    assert.equal(result.sent, false);
    assert.equal(sendCalls, 0);
  }
});

test("acquisition stage registry owns aliases and all persisted stage names", async () => {
  assert.deepEqual(ACQUISITION_STAGE_LIST, [
    "ownership_check",
    "consider_selling",
    "asking_price",
    "condition",
    "offer_negotiation",
  ]);
  assert.equal(normalizeAcquisitionStage("selling_interest"), "consider_selling");
  assert.equal(normalizeAcquisitionStage("price_or_offer"), "asking_price");
  assert.equal(normalizeAcquisitionStage("seller_price_discovery"), "asking_price");
  assert.ok(ACQUISITION_STAGE_LIST.every(isCanonicalAcquisitionStage));

  const supabase = makeMemorySupabase({
    acquisition_contacts: [],
  });
  const deps = makeDeps(supabase);
  const created = await getOrCreateAcquisitionContact(
    {
      phone: "+15551230121",
      property_id: "property-stage-registry",
      current_stage: "selling_interest",
    },
    deps
  );
  assert.equal(created.contact.current_stage, "consider_selling");

  const updated = await updateStage(
    created.contact.id,
    "price_or_offer",
    {},
    deps
  );
  assert.equal(updated.contact.current_stage, "asking_price");

  const acquisitionModuleUrls = [
    new URL("../../src/lib/domain/acquisition/acquisition-contact-service.js", import.meta.url),
    new URL("../../src/lib/domain/acquisition/compliance-handler.js", import.meta.url),
    new URL("../../src/lib/domain/acquisition/delivery-receipt-handler.js", import.meta.url),
    new URL("../../src/lib/domain/acquisition/delivery-retry-engine.js", import.meta.url),
    new URL("../../src/lib/domain/acquisition/inbound-dispatcher.js", import.meta.url),
    new URL("../../src/lib/domain/acquisition/no-reply-followup-scheduler.js", import.meta.url),
  ];
  for (const moduleUrl of acquisitionModuleUrls) {
    const source = readFileSync(moduleUrl, "utf8");
    assert.doesNotMatch(source, /["']selling_interest["']/);
    assert.doesNotMatch(source, /["']price_or_offer["']/);
  }
});

test("acquisition events are isolated from Workflow Studio runtime storage", () => {
  assert.equal(ACQUISITION_EVENTS_TABLE, "acquisition_events");
  const source = readFileSync(
    new URL(
      "../../src/lib/domain/acquisition/acquisition-event-service.js",
      import.meta.url
    ),
    "utf8"
  );
  assert.doesNotMatch(source, /workflow_events/);
});

test("offer runtime control gates every legacy inbound offer mutation path", () => {
  const source = readFileSync(
    new URL("../../src/lib/flows/handle-textgrid-inbound.js", import.meta.url),
    "utf8"
  );

  assert.match(
    source,
    /offer_routing = !acquisition_offer_automation_enabled/
  );
  assert.match(
    source,
    /maybe_offer_progress = !acquisition_offer_automation_enabled/
  );
  assert.match(
    source,
    /initial_offer = maybe_offer_progress\?\.updated[\s\S]*?!acquisition_offer_automation_enabled/
  );
  assert.match(
    source,
    /maybe_offer =\s*!acquisition_offer_automation_enabled \|\|/
  );
});

test("acquisition migration is self-contained and seeds every control disabled", () => {
  const migration = readFileSync(
    new URL(
      "../../supabase/migrations/20260612120000_acquisition_contacts.sql",
      import.meta.url
    ),
    "utf8"
  );
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.acquisition_events/);
  assert.match(migration, /uq_acquisition_events_provider_receipt/);
  assert.match(migration, /public\.acquisition_touch_updated_at/);
  assert.doesNotMatch(migration, /\bDROP\b/i);
  assert.doesNotMatch(migration, /workflow_events|workflow_touch_updated_at/);

  for (const flag of Object.values(ACQUISITION_RUNTIME_FLAGS)) {
    assert.match(migration, new RegExp(`'${flag}', 'false'`));
  }
});
