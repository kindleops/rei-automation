#!/usr/bin/env node
/**
 * IC8 Phase 4 -- production extract for the first-touch baselines.
 *
 * READ-ONLY. Pulls exactly the columns the v1 feature definitions, the
 * outcome labeler, the exclusions and the template off-policy evaluation need,
 * into a PII-minimised local work cache OUTSIDE the repo:
 *
 *   - phones / thread keys are replaced on receipt by a keyed pseudonym
 *     (lib/first-touch.pseudonymizeKey); only the 5 internal test numbers
 *     (public in config/internal-phones.js) are kept verbatim so the
 *     exclusions can drop them;
 *   - message bodies are NOT extracted here (the snapshot builder reads the
 *     ~1.5K inbound rows into memory only, for the reply_meaningful@1 and
 *     opt_out_keyword@1 rules);
 *   - the feeder's rotation seed (embeds owner/property/phone ids) is verified
 *     in memory and dropped; only the pool, index and the verdict are kept;
 *   - template copy is reduced to text-free attributes;
 *   - no names, emails or addresses are requested at all.
 *
 * Gentle: keyset pages of <= 1000 rows / `in` batches of <= 150 ids, a pause
 * between calls, authenticator statement_timeout 8s + a 20s client abort,
 * checkpointed per table (rerun to resume).
 *
 * Not readable through this path: seller.property_sale / property_mortgage
 * (schema `seller` is not exposed by PostgREST: PGRST106; the only public RPC
 * over them, entity_graph_property_records, is one call per property and
 * returns names/lenders, so it is NOT used). The two features that read them
 * are reported as unavailable.
 *
 * Run from apps/api:
 *   node --env-file=.env.local --no-warnings --loader ./tests/alias-loader.mjs \
 *     scripts/intelligence/baselines/extract-first-touch.mjs
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { internalPhoneSpellings } from "../../../src/lib/domain/intelligence/datasets/exclusions.js";
import { createRestReader } from "./lib/rest-reader.mjs";
import { pseudonymizeKey, summarizeRotation, templateAttributes } from "./lib/first-touch.mjs";

export const EXTRACT_VERSION = "ic8_first_touch_extract@1";
export const DEFAULT_WORK_DIR = "/Users/ryankindle/.claude/jobs/c39b0175/tmp/ic8/datasets/_work/first_touch_extract_v1";

/** Secret for pseudonyms and dataset salts: derived from the service key, never written or printed. */
export function deriveSecret(purpose) {
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");
  if (key.length < 20) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required (never printed)");
  return createHash("sha256").update(`ic8-baselines|${purpose}|${key}`).digest("hex");
}

const INTERNAL = internalPhoneSpellings();
const SEND_COLUMNS = [
  "id",
  "thread_key",
  "to_phone_number",
  "property_id",
  "master_owner_id",
  "campaign_id",
  "template_id",
  "use_case_template",
  "source",
  "message_type",
  "queue_status",
  "sent_at",
  "created_at",
  "delivered_at",
  "timezone",
  "language",
  "md_internal_canary:metadata->>internal_canary",
  "md_exclude_from_kpis:metadata->>exclude_from_kpis",
  "md_internal_test:metadata->>internal_test",
  "md_spam_retry_generation:metadata->>spam_retry_generation",
  "md_cs_internal_canary:metadata->candidate_snapshot->>internal_canary",
  "md_selected_template_language:metadata->>selected_template_language",
  "md_snapshot_language:metadata->template_snapshot->>language",
  "md_rotation_seed:metadata->>template_rotation_seed",
  "md_rotation_pool_size:metadata->>template_rotation_pool_size",
  "md_rotation_selected_index:metadata->>template_rotation_selected_index",
  "md_rotation_candidate_ids:metadata->template_rotation_candidate_ids",
  "md_rotation_strategy:metadata->>template_rotation_strategy",
].join(",");

function transformSends(secret) {
  return (rows) =>
    rows.map((r) => {
      const phones = [r.thread_key, r.to_phone_number].map((v) => String(v ?? "").trim());
      const internal = phones.find((p) => p && INTERNAL.has(p)) || null;
      const rotation = r.md_rotation_seed
        ? summarizeRotation({
            seed: r.md_rotation_seed,
            poolSize: Number(r.md_rotation_pool_size),
            selectedIndex: r.md_rotation_selected_index === null ? null : Number(r.md_rotation_selected_index),
            candidateIds: r.md_rotation_candidate_ids,
            templateId: r.template_id,
          })
        : null;
      return {
        id: r.id,
        hk: pseudonymizeKey(r.thread_key || r.to_phone_number, secret),
        internal_phone: internal,
        property_id: r.property_id,
        master_owner_id: r.master_owner_id,
        campaign_id: r.campaign_id,
        template_id: r.template_id,
        use_case_template: r.use_case_template,
        source: r.source,
        message_type: r.message_type,
        queue_status: r.queue_status,
        sent_at: r.sent_at,
        created_at: r.created_at,
        delivered_at: r.delivered_at,
        timezone: r.timezone,
        template_language: r.language || r.md_selected_template_language || r.md_snapshot_language || null,
        metadata: {
          internal_canary: r.md_internal_canary,
          exclude_from_kpis: r.md_exclude_from_kpis,
          internal_test: r.md_internal_test,
          spam_retry_generation: r.md_spam_retry_generation,
          candidate_snapshot_internal_canary: r.md_cs_internal_canary,
        },
        rotation: rotation ? { ...rotation, strategy: r.md_rotation_strategy || null } : null,
      };
    });
}

export async function runExtract({ workDir = DEFAULT_WORK_DIR, log = console.log } = {}) {
  const { supabase, hasSupabaseConfig } = await import("@/lib/supabase/client.js");
  if (!hasSupabaseConfig()) throw new Error("supabase_config_missing");
  const secret = deriveSecret("pseudonym@1");
  const reader = createRestReader({ supabase, workDir, paceMs: 300, log });
  const startedAt = new Date().toISOString();

  log("send_queue (all sends: prior-touch history + first-touch population)");
  const sends = await reader.scan("sends", {
    query: () => supabase.from("send_queue").select(SEND_COLUMNS),
    transform: transformSends(secret),
  });

  log("outbound failure events");
  await reader.scan("outbound_failures", {
    query: () =>
      supabase
        .from("message_events")
        .select("id,queue_id,failure_bucket,event_type,created_at")
        .eq("direction", "outbound")
        .not("failure_bucket", "is", null),
  });

  const firstTouch = sends.filter((s) => s.use_case_template === "ownership_check" && s.sent_at);
  const propertyIds = firstTouch.map((s) => s.property_id);
  const ownerIds = firstTouch.map((s) => s.master_owner_id);

  log("properties (structural facts of first-touch properties)");
  await reader.lookup("properties", {
    ids: propertyIds,
    column: "property_id",
    query: () =>
      supabase
        .from("properties")
        .select(
          "property_id,canonical_market_id,market,property_address_state,property_address_zip,property_type,asset_class,units_count,building_square_feet,total_bedrooms,total_baths,year_built,lot_square_feet",
        ),
  });

  log("master_owners (entity class + language/persona attributes)");
  await reader.lookup("owners", {
    ids: ownerIds,
    column: "master_owner_id",
    query: () => supabase.from("master_owners").select("master_owner_id,owner_type_guess,best_language,agent_persona,agent_family"),
  });

  log("phones (owner -> primary prospect; phone pseudonymised on receipt)");
  const phones = await reader.lookup("phones", {
    ids: ownerIds,
    column: "master_owner_id",
    batchSize: 100,
    query: () => supabase.from("phones").select("phone_id,master_owner_id,canonical_e164,primary_prospect_id"),
    transform: (rows) =>
      rows.map((r) => ({
        phone_id: r.phone_id,
        master_owner_id: r.master_owner_id,
        hk: pseudonymizeKey(r.canonical_e164, secret),
        primary_prospect_id: r.primary_prospect_id,
      })),
  });

  log("prospects (personal attributes, by primary prospect id)");
  await reader.lookup("prospects", {
    ids: phones.map((p) => p.primary_prospect_id),
    column: "prospect_id",
    query: () =>
      supabase
        .from("prospects")
        .select("prospect_id,mob,est_household_income,education_model,occupation_group,gender,marital_status,language_preference"),
  });

  log("campaigns (test flags for campaignIntegrity)");
  await reader.scan("campaigns", {
    query: () =>
      supabase
        .from("campaigns")
        .select(
          "id,name,candidate_source,md_proof:metadata->>proof,md_internal_proof:metadata->>internal_proof,md_internal_canary:metadata->>internal_canary,md_not_business_data:metadata->>not_business_data,md_canary:metadata->>canary,md_test_fixture:metadata->>test_fixture,md_proof_probe:metadata->>proof_probe,md_source:metadata->>source,md_production_launch:metadata->>production_launch,md_quarantine_active:metadata->>quarantine_active",
        ),
  });

  log("sms_templates (text-free attributes of logged pools + chosen templates)");
  const templateIds = new Set();
  for (const s of firstTouch) {
    if (s.template_id) templateIds.add(String(s.template_id));
    for (const id of s.rotation?.pool_ids || []) templateIds.add(String(id));
  }
  await reader.lookup("templates", {
    ids: [...templateIds],
    column: "template_id",
    batchSize: 100,
    query: () => supabase.from("sms_templates").select("template_id,use_case,language,stage_code,variant_group_key,is_active,template_body"),
    transform: (rows) =>
      rows.map((r) => ({
        template_id: r.template_id,
        use_case: r.use_case,
        language: r.language,
        stage_code: r.stage_code,
        variant_group_key: r.variant_group_key,
        is_active: r.is_active,
        ...templateAttributes(r.template_body),
      })),
  });

  log("template governance now (current state, for policy definitions only)");
  await reader.scan("rotation_control", {
    key: "template_id",
    query: () => supabase.from("ownership_template_rotation_control").select("template_id,rotation_status,updated_at"),
  });
  await reader.scan("system_control_templates", {
    key: "key",
    query: () => supabase.from("system_control").select("key,value,updated_at").in("key", ["sms_blocked_template_ids"]),
  });

  log("stage history (feasibility only)");
  await reader.scan("opportunity_stage_history", {
    query: () =>
      supabase
        .from("acquisition_opportunity_history")
        .select("id,opportunity_id,event_type,field_name,previous_value,new_value,actor,source,created_at")
        .eq("field_name", "acquisition_stage"),
  });
  await reader.scan("lead_state_stage_events", {
    query: () =>
      supabase
        .from("universal_lead_state_events")
        .select("id,thread_key,field_name,previous_value,new_value,change_source,source_view,reason,created_at")
        .eq("field_name", "lifecycle_stage"),
    transform: (rows) =>
      rows.map((r) => ({
        id: r.id,
        hk: pseudonymizeKey(r.thread_key, secret),
        field_name: r.field_name,
        previous_value: r.previous_value,
        new_value: r.new_value,
        change_source: r.change_source,
        source_view: r.source_view,
        qa_reason: /certification|regression_probe|restore test fixture/i.test(String(r.reason ?? "")),
        created_at: r.created_at,
      })),
  });
  await reader.scan("opportunities", {
    query: () => supabase.from("acquisition_opportunities").select("id,acquisition_stage,opportunity_status,promotion_reason,stage_entered_at,created_at"),
  });

  const manifest = {
    extract_version: EXTRACT_VERSION,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    project: "lcppdrmrdfblstpcbgpf",
    access: "service-role Supabase client (PostgREST GETs only); authenticator statement_timeout 8s; 20s client abort; 300ms pace",
    pii: "thread keys/phones -> keyed pseudonym (secret derived from the service key, never written); no names/emails/addresses; no message bodies; rotation seeds dropped after verification; template copy -> attributes",
    unavailable: {
      "seller.property_sale": "schema not exposed by PostgREST (PGRST106); direct PG password stale (28P01)",
      "seller.property_mortgage": "same",
    },
    stats: reader.stats(),
  };
  fs.writeFileSync(path.join(workDir, "extract-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  log(`extract complete: ${manifest.stats.calls} REST calls`);
  return manifest;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runExtract().catch((error) => {
    console.error(`extract failed: ${String(error?.message || error).slice(0, 300)}`);
    process.exit(1);
  });
}
