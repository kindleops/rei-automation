import "../../apps/api/tests/register-aliases.mjs";

process.env.ENABLE_AI_ASSIST = "false";
process.env.OPENAI_KEY ||= "test-openai-key";

const { classify } = await import("../../apps/api/src/lib/domain/classification/classify.js");
const { executeInboundAutomationDecision } = await import(
  "../../apps/api/src/lib/domain/seller-flow/apply-inbound-automation-decision.js"
);

class FakeQuery {
  constructor(rows = []) {
    this.rows = rows;
    this.filters = [];
    this.single = false;
    this.limitCount = null;
  }

  select() {
    return this;
  }

  eq(column, value) {
    this.filters.push((row) => row?.[column] === value);
    return this;
  }

  in(column, values = []) {
    this.filters.push((row) => values.includes(row?.[column]));
    return this;
  }

  gte(column, value) {
    this.filters.push((row) => String(row?.[column] ?? "") >= String(value));
    return this;
  }

  limit(count) {
    this.limitCount = count;
    return this;
  }

  maybeSingle() {
    this.single = true;
    return this;
  }

  then(resolve, reject) {
    return Promise.resolve(this.buildResult()).then(resolve, reject);
  }

  buildResult() {
    let data = this.rows.filter((row) => this.filters.every((filter) => filter(row)));
    if (typeof this.limitCount === "number") {
      data = data.slice(0, this.limitCount);
    }

    if (this.single) {
      return { data: data[0] || null, error: null };
    }

    return { data, error: null };
  }
}

function createFakeSupabaseClient() {
  const templates = [
    {
      id: "tmpl_consider_selling_en",
      template_id: "tmpl_consider_selling_en",
      template_body: "Thanks for confirming. Would you consider selling if the price made sense?",
      use_case: "consider_selling",
      stage_code: "consider_selling",
      stage_label: "Consider Selling",
      language: "English",
      is_active: true,
      safe_for_auto_reply: true,
      reply_mode: "auto",
      success_rate: 0.9,
      usage_count: 200,
      updated_at: "2026-05-29T00:00:00.000Z",
    },
    {
      id: "tmpl_seller_asking_price_en",
      template_id: "tmpl_seller_asking_price_en",
      template_body: "Got it. What price were you hoping to be at for the property?",
      use_case: "seller_asking_price",
      stage_code: "seller_asking_price",
      stage_label: "Seller Asking Price",
      language: "English",
      is_active: true,
      safe_for_auto_reply: true,
      reply_mode: "auto",
      success_rate: 0.88,
      usage_count: 150,
      updated_at: "2026-05-29T00:00:00.000Z",
    },
    {
      id: "tmpl_price_response_en",
      template_id: "tmpl_price_response_en",
      template_body: "Thanks for sharing that price. Is the property tenant occupied or does it need any major repairs?",
      use_case: "price_works_confirm_basics",
      stage_code: "price_works_confirm_basics",
      stage_label: "Price Works Confirm Basics",
      language: "English",
      is_active: true,
      safe_for_auto_reply: true,
      reply_mode: "auto",
      success_rate: 0.87,
      usage_count: 140,
      updated_at: "2026-05-29T00:00:00.000Z",
    },
    {
      id: "tmpl_text_only_redirect_en",
      template_id: "tmpl_text_only_redirect_en",
      template_body: "I can keep it over text here. What's the best time window for you to text back?",
      use_case: "text_only_redirect",
      stage_code: "text_only_redirect",
      stage_label: "Text Only Redirect",
      language: "English",
      is_active: true,
      safe_for_auto_reply: true,
      reply_mode: "auto",
      success_rate: 0.85,
      usage_count: 90,
      updated_at: "2026-05-29T00:00:00.000Z",
    },
    {
      id: "tmpl_tenant_probe_en",
      template_id: "tmpl_tenant_probe_en",
      template_body: "Thanks. Are the tenants month to month or on a lease right now?",
      use_case: "tenant_probe",
      stage_code: "tenant_probe",
      stage_label: "Tenant Probe",
      language: "English",
      is_active: true,
      safe_for_auto_reply: true,
      reply_mode: "auto",
      success_rate: 0.84,
      usage_count: 80,
      updated_at: "2026-05-29T00:00:00.000Z",
    },
  ];

  return {
    from(table) {
      if (table === "sms_templates") return new FakeQuery(templates);
      if (table === "send_queue") return new FakeQuery([]);
      if (table === "phones") return new FakeQuery([]);
      if (table === "sms_suppression_list") return new FakeQuery([]);
      return new FakeQuery([]);
    },
  };
}

const fakeSupabase = createFakeSupabaseClient();

const CASES = [
  {
    label: "A",
    text: "Yes I own it",
    expect: {
      primary_intent: "ownership_confirmed",
      should_queue_reply: true,
      route_hint: "consider_selling",
    },
  },
  {
    label: "B",
    text: "How much are you offering?",
    expect: {
      primary_intent: "asks_offer",
      should_queue_reply: true,
      route_hint: "ask_seller_price_or_basic_condition",
    },
  },
  {
    label: "C",
    text: "80k",
    expect: {
      primary_intent: "asking_price_provided",
      should_queue_reply: true,
      route_hint: "price_response",
    },
  },
  {
    label: "D",
    text: "Stop texting me",
    expect: {
      primary_intent: "opt_out",
      should_queue_reply: false,
      should_suppress_contact: true,
    },
  },
  {
    label: "E",
    text: "Buzz off",
    expect: {
      primary_intent: "hostile_or_legal",
      should_queue_reply: false,
      should_mark_human_review: true,
    },
  },
  {
    label: "F",
    text: "I'm block",
    expect: {
      primary_intent: "unclear",
      should_queue_reply: false,
      should_mark_human_review: true,
    },
  },
  {
    label: "G",
    text: "Call me",
    expect: {
      primary_intent: "callback_requested",
      should_queue_reply: true,
      route_hint: "text_only_redirect",
    },
  },
  {
    label: "H",
    text: "There are tenants",
    expect: {
      primary_intent: "tenant_occupied",
      should_queue_reply: true,
      route_hint: "rental_underwriting",
    },
  },
];

function summarize(result) {
  return {
    primary_intent: result.classification.primary_intent,
    objection: result.classification.objection,
    compliance_flag: result.classification.compliance_flag,
    confidence: result.classification.confidence,
    automation_decision: result.automation_decision,
    selected_template_use_case: result.selected_template?.use_case || null,
    selected_template_stage_code: result.selected_template?.stage_code || null,
    rendered_message_text: result.rendered_message_text || null,
    audit_reason: result.audit_reason,
  };
}

for (const testCase of CASES) {
  const classification = await classify(testCase.text);
  const execution = await executeInboundAutomationDecision({
    message: testCase.text,
    threadKey: "+15551234567",
    propertyId: "prop_1",
    prospectId: "prospect_1",
    ownerId: "owner_1",
    phoneId: "phone_1",
    classification,
    latestThreadContext: {
      ids: {
        property_id: "prop_1",
        master_owner_id: "owner_1",
        phone_item_id: "phone_1",
      },
      summary: {
        property_type: "Single Family",
        property_type_scope: "Single Family",
      },
    },
    context: {
      ids: {
        property_id: "prop_1",
        master_owner_id: "owner_1",
        phone_item_id: "phone_1",
        textgrid_number_id: "tg_1",
      },
      summary: {
        property_type: "Single Family",
        property_type_scope: "Single Family",
        market_timezone: "America/Chicago",
        contact_window: "12AM-11:59PM CT",
      },
    },
    inboundFrom: "+15551234567",
    inboundTo: "+15557654321",
    inboundEventId: `proof_${testCase.label}`,
    enableQueueInsert: false,
    applySuppression: false,
    dryRun: true,
    supabaseClient: fakeSupabase,
  });

  const pass =
    classification.primary_intent === testCase.expect.primary_intent &&
    execution.automation_decision.should_queue_reply === testCase.expect.should_queue_reply &&
    (testCase.expect.route_hint
      ? execution.automation_decision.route_hint === testCase.expect.route_hint
      : true) &&
    (testCase.expect.should_suppress_contact !== undefined
      ? execution.automation_decision.should_suppress_contact === testCase.expect.should_suppress_contact
      : true) &&
    (testCase.expect.should_mark_human_review !== undefined
      ? execution.automation_decision.should_mark_human_review === testCase.expect.should_mark_human_review
      : true);

  console.log(`\n[${testCase.label}] ${testCase.text}`);
  console.log(`PASS: ${pass ? "yes" : "no"}`);
  console.log(JSON.stringify(summarize({
    classification,
    ...execution,
  }), null, 2));

  if (!pass) {
    process.exitCode = 1;
  }
}
