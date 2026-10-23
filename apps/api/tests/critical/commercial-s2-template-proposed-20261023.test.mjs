/**
 * PROPOSED DATA STEP (2026-10-23): the owner-approved commercial S2 "consider selling" row,
 * scripts/ops/commercial-s2-template-20261023/PROPOSED_insert.sql (inserted INACTIVE; activation is
 * a separate file).
 *
 * The row is built from that SQL file's own constants. The owner wording, the placeholder mapping,
 * the allowed and prohibited lists and the scope all come from the file, so the test and the data
 * step cannot drift. The proofs:
 *   - the wording as typed cannot render ({{first_name}} / {{company_name}} are not renderer
 *     variables), so the mapping and the company refusal are needed;
 *   - with the row ACTIVE, a commercial owner's "Yes" to the ownership question selects it, with
 *     the property given or recovered from the inbound's message_events row;
 *   - it is NEVER selected for a residential property (single-family, duplex, 5+, multi-family with
 *     unknown units, residential with unknown type, or a residential scope label), and the send-time
 *     guard refuses it on one;
 *   - as inserted (is_active = false) it is never selected, and a commercial "Yes" still holds.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { personalizeTemplate } from "@/lib/sms/personalize_template.js";
import {
  COMMERCIAL_GROUPS,
  RESIDENTIAL_GROUPS,
  isTemplateCompatibleWithProperty,
  templateAllowedGroups,
  templateScopeKind,
} from "@/lib/domain/templates/template-asset-compatibility.js";
import { evaluateTemplateAssetGuard } from "@/lib/domain/queue/template-asset-guard.js";
import { executeInboundAutomationDecision } from "@/lib/domain/seller-flow/apply-inbound-automation-decision.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SQL_DIR = path.resolve(here, "../../../../scripts/ops/commercial-s2-template-20261023");
const INSERT_SQL = readFileSync(path.join(SQL_DIR, "PROPOSED_insert.sql"), "utf8");

const sqlConst = (name) => {
  const m = INSERT_SQL.match(new RegExp(`${name}\\s+constant\\s+text(\\[\\])?\\s*:=\\s*(.+?);\\n`));
  assert.ok(m, `constant ${name} in PROPOSED_insert.sql`);
  if (m[1]) return [...m[2].matchAll(/'([^']*)'/g)].map((x) => x[1]);
  return m[2].trim().replace(/^'|'$/g, "").replace(/''/g, "'");
};
const TEMPLATE_ID = sqlConst("c_template_id");
const OWNER_WORDING = sqlConst("c_owner_wording");
const ALLOWED = sqlConst("c_allowed");
const PROHIBITED = sqlConst("c_prohibited");
// A test-only stand-in. The production value is the owner's to type into v_company_literal.
const COMPANY = "Example Holdings";
// The same mapping PROPOSED_insert.sql applies.
const MAPPED_BODY = OWNER_WORDING.replace("{{first_name}}", "{{seller_first_name}}").replace("{{company_name}}", COMPANY);

const ROW_AS_INSERTED = {
  template_id: TEMPLATE_ID, use_case: "consider_selling", stage_code: "S2", language: "English",
  is_active: false, safe_for_auto_reply: true, reply_mode: "auto_reply", quarantine_state: "active",
  property_type_scope: "Commercial (Other)", allowed_property_groups: ALLOWED, prohibited_property_groups: PROHIBITED,
  template_body: MAPPED_BODY,
};
const ROW_ACTIVE = { ...ROW_AS_INSERTED, is_active: true };
const S2_ANY_RES = { template_id: "400065", use_case: "consider_selling", stage_code: "S2", language: "English", is_active: true, safe_for_auto_reply: true, reply_mode: "auto_reply", property_type_scope: "Any Residential", allowed_property_groups: null, template_body: "Thanks for confirming. Would you consider a proposal for the property?" };

function tableSupabase(tables = {}) {
  const from = (table) => {
    const filters = [];
    const rows = () => (tables[table] || []).filter((r) => filters.every((f) => f(r)));
    const chain = {
      select: () => chain,
      eq: (c, v) => (filters.push((r) => String(r?.[c]) === String(v)), chain),
      in: (c, vs) => (filters.push((r) => (vs || []).map(String).includes(String(r?.[c]))), chain),
      is: () => chain, gte: () => chain, lte: () => chain, lt: () => chain, gt: () => chain, or: () => chain, not: () => chain, neq: () => chain, order: () => chain, ilike: () => chain,
      update: () => chain, insert: () => chain, upsert: () => chain,
      limit: async () => ({ data: rows(), error: null }),
      maybeSingle: async () => ({ data: rows()[0] || null, error: null }),
      single: async () => ({ data: rows()[0] || null, error: null }),
      then: (resolve, reject) => Promise.resolve({ data: rows(), error: null }).then(resolve, reject),
    };
    return chain;
  };
  return { from, rpc: async () => ({ data: null, error: null }) };
}

const THREAD = "+12815555725";
const contextFor = (summaryExtra = {}) => ({
  found: true, inbound_from: THREAD, ids: { master_owner_id: "mo-1", prospect_id: null, property_id: null }, items: {}, flags: {},
  recent: { recently_used_template_ids: [], touch_count: 1, recent_events: [] },
  summary: { conversation_stage: "ownership_check", property_address: "1 Main St", seller_first_name: "Pat", agent_name: "Sam", language_preference: "English", ...summaryExtra },
});
const YES = { primary_intent: "ownership_confirmed", confidence: 0.9, language: "English", reply_language_source: "seller_reply", automation_decision: { auto_reply_allowed: true, queue_action: "queue_auto_reply", human_review_required: false }, message: "Yes" };

function runYes({ templates, property = null, propertyId = null, viaEvent = false, summaryExtra = {} }) {
  const ctx = contextFor(summaryExtra);
  return executeInboundAutomationDecision({
    message: "Yes", threadKey: THREAD, inboundFrom: THREAD, inboundTo: "+18325550100", ownerId: "mo-1", propertyId,
    latestThreadContext: ctx, context: ctx, classification: YES, effectiveStageBefore: "ownership_confirmation",
    inboundEventId: "evt-yes", inboundReceivedAt: "2026-10-23T18:00:00Z", dryRun: true, autoReplyMode: "dry_run", applySuppression: false,
    supabaseClient: tableSupabase({
      sms_templates: templates,
      properties: property ? [property] : [],
      message_events: viaEvent && property ? [{ id: "evt-yes", property_id: property.property_id }] : [],
    }),
  });
}

const COMMERCIAL = { property_id: "2131479286", property_type: "Other", property_class: "Commercial" };
const RESIDENTIAL = {
  sfr: { property_id: "r-sfr", property_type: "Single Family", property_class: "Residential", units_count: 1 },
  duplex: { property_id: "r-dx", property_type: "Multi-Family", property_class: "Residential", units_count: 2 },
  five_plus: { property_id: "r-5p", property_type: "Multi-Family", property_class: "Residential", units_count: 12 },
  mf_units_unknown: { property_id: "r-mfu", property_type: "Multi-Family", property_class: "Residential", units_count: 1 },
  residential_type_unknown: { property_id: "r-res", property_class: "Residential" },
};

// ── the data step itself ─────────────────────────────────────────────────
test("the SQL proposes the owner's wording, inactive, Commercial (Other), auto_reply, with the asset rule's commercial groups", () => {
  assert.equal(OWNER_WORDING, "Hi {{first_name}}, this is {{sender_name}} with {{company_name}}. Would you consider selling your property at {{property_address}}? Reply STOP to opt out.");
  assert.equal(TEMPLATE_ID, "lc-s2-consider-com-en-01");
  assert.deepEqual([...ALLOWED].sort(), [...COMMERCIAL_GROUPS].sort());
  assert.deepEqual([...PROHIBITED].sort(), [...RESIDENTIAL_GROUPS, "land"].sort());
  assert.equal(templateScopeKind(ROW_AS_INSERTED), "commercial");
  assert.deepEqual([...templateAllowedGroups(ROW_AS_INSERTED)].sort(), [...COMMERCIAL_GROUPS].sort());
  assert.match(INSERT_SQL, /\n\s+false, v_safe_values\[1\], 'auto_reply',/, "is_active = false in the INSERT");
  assert.match(INSERT_SQL, /v_company_literal text := NULL;/, "no company value is pre-filled");
  assert.doesNotMatch(MAPPED_BODY, /[–—]/, "no em / en dash");
});

test("the wording as typed cannot render: {{first_name}} and {{company_name}} are not renderer variables", () => {
  const vars = { seller_first_name: "Pat", first_name: "Pat", agent_name: "Sam", property_address: "1 Main St", company_name: "Example Holdings" };
  const asTyped = personalizeTemplate(OWNER_WORDING, vars);
  assert.equal(asTyped.ok, false);
  assert.deepEqual([...asTyped.missing].sort(), ["company_name", "first_name"]);
  const mapped = personalizeTemplate(MAPPED_BODY, vars);
  assert.equal(mapped.ok, true, mapped.reason);
  assert.equal(mapped.text, "Hi Pat, this is Sam with Example Holdings. Would you consider selling your property at 1 Main St? Reply STOP to opt out.");
});

// ── selection ────────────────────────────────────────────────────────────
test("ACTIVE row: a commercial owner's 'Yes' to the ownership question selects it (property given, or recovered from the inbound event)", async () => {
  for (const shape of [{ propertyId: COMMERCIAL.property_id }, { viaEvent: true }, { viaEvent: true, summaryExtra: { property_type: "Commercial" } }]) {
    const r = await runYes({ templates: [S2_ANY_RES, ROW_ACTIVE], property: COMMERCIAL, ...shape });
    assert.equal(r.selected_template?.template_id, TEMPLATE_ID, `${JSON.stringify(shape)}: ${r.automation_decision?.human_review_reason}`);
    assert.equal(r.automation_decision.route_hint, "consider_selling");
    assert.equal(r.rendered_message_text, "Hi Pat, this is Sam with Example Holdings. Would you consider selling your property at 1 Main St? Reply STOP to opt out.");
  }
});

test("ACTIVE row: every commercial group is eligible; no residential group or land is", () => {
  for (const g of COMMERCIAL_GROUPS) assert.equal(isTemplateCompatibleWithProperty({ template: ROW_ACTIVE, propertyGroup: g }).compatible, true, g);
  for (const g of [...RESIDENTIAL_GROUPS, "land", "residential", "multifamily_units_unknown", "unknown"]) {
    assert.equal(isTemplateCompatibleWithProperty({ template: ROW_ACTIVE, propertyGroup: g }).compatible, false, g);
  }
});

test("ACTIVE row is NEVER selected for a residential property: the residential S2 row is, or the reply holds", async () => {
  for (const [label, property] of Object.entries(RESIDENTIAL)) {
    for (const shape of [{ propertyId: property.property_id }, { viaEvent: true }]) {
      const withResidential = await runYes({ templates: [ROW_ACTIVE, S2_ANY_RES], property, ...shape });
      assert.notEqual(withResidential.selected_template?.template_id, TEMPLATE_ID, `${label} ${JSON.stringify(shape)}`);
      assert.equal(withResidential.selected_template?.template_id, "400065", `${label}: ${withResidential.automation_decision?.human_review_reason}`);
      const onlyCommercial = await runYes({ templates: [ROW_ACTIVE], property, ...shape });
      assert.equal(onlyCommercial.selected_template, null, label);
      assert.equal(onlyCommercial.queued, false, label);
      assert.equal(onlyCommercial.automation_decision.human_review_reason, "asset_compatible_template_missing", label);
    }
  }
});

test("ACTIVE row is never selected on a residential scope label when no property record exists", async () => {
  for (const property_type of ["Single Family", "Residential", "Multi-Family", "Duplex"]) {
    const r = await runYes({ templates: [ROW_ACTIVE], summaryExtra: { property_type } });
    assert.equal(r.selected_template, null, property_type);
    const both = await runYes({ templates: [ROW_ACTIVE, S2_ANY_RES], summaryExtra: { property_type } });
    assert.notEqual(both.selected_template?.template_id, TEMPLATE_ID, property_type);
  }
});

test("the send-time guard admits a queued reply with this row on commercial and refuses it on residential", async () => {
  const properties = { [COMMERCIAL.property_id]: COMMERCIAL, ...Object.fromEntries(Object.values(RESIDENTIAL).map((p) => [p.property_id, p])) };
  const supabase = {
    from(table) {
      const filters = {};
      const chain = {
        select() { return chain; },
        eq(col, value) { filters[col] = value; return chain; },
        maybeSingle() {
          const src = table === "properties" ? properties[filters.property_id] : table === "sms_templates" && filters.template_id === TEMPLATE_ID ? ROW_ACTIVE : null;
          return Promise.resolve({ data: src ?? null, error: null });
        },
      };
      return chain;
    },
  };
  const body = "Hi Pat, this is Sam with Example Holdings. Would you consider selling your property at 1 Main St? Reply STOP to opt out.";
  const allowed = await evaluateTemplateAssetGuard({ supabase, queue_row: { property_id: COMMERCIAL.property_id, selected_template_id: TEMPLATE_ID }, body });
  assert.equal(allowed.allowed, true, allowed.reason);
  for (const p of Object.values(RESIDENTIAL)) {
    const v = await evaluateTemplateAssetGuard({ supabase, queue_row: { property_id: p.property_id, selected_template_id: TEMPLATE_ID }, body });
    assert.equal(v.allowed, false, `${p.property_id}: ${v.reason}`);
  }
});

test("AS INSERTED (is_active = false) the row is never selected: a commercial 'Yes' still holds for a person", async () => {
  const r = await runYes({ templates: [S2_ANY_RES, ROW_AS_INSERTED], property: COMMERCIAL, viaEvent: true });
  assert.equal(r.selected_template, null);
  assert.equal(r.queued, false);
  assert.equal(r.automation_decision.human_review_reason, "asset_compatible_template_missing");
});
