#!/usr/bin/env node

import { createMarker, readRel } from "./campaign-proof-utils.mjs";

const marker = createMarker();
const label = "campaign schema proof";

const migration = readRel("apps/api/supabase/migrations/20260531000015_campaign_automation_foundation.sql");
const graphMigration = readRel("apps/api/supabase/migrations/20260601230627_campaign_target_graph.sql");
const service = readRel("apps/api/src/lib/domain/campaigns/campaign-automation-service.js");
const catalog = readRel("apps/api/src/lib/domain/campaigns/campaign-field-catalog.js");

for (const table of [
  "campaigns",
  "campaign_filters",
  "campaign_targets",
  "campaign_send_windows",
  "campaign_runs",
  "campaign_events",
]) {
  marker.mark(`migration creates or extends ${table}`, migration.includes(`public.${table}`));
}

for (const column of [
  "objective",
  "candidate_source",
  "language_policy",
  "daily_cap",
  "total_cap",
  "batch_max",
  "market_cap",
  "per_sender_cap",
  "send_interval_seconds",
  "contact_window_start",
  "contact_window_end",
  "auto_queue_enabled",
  "auto_send_enabled",
  "auto_reply_mode",
  "emergency_stop_at",
  "metadata jsonb",
]) {
  marker.mark(`campaigns column present ${column}`, migration.includes(column));
}

for (const column of [
  "campaign_id",
  "master_owner_id",
  "property_id",
  "phone_id",
  "to_phone_number",
  "owner_name",
  "property_address",
  "timezone",
  "priority_score",
  "identity_status",
  "routing_status",
  "suppression_status",
  "template_status",
  "target_status",
  "block_reason",
]) {
  marker.mark(`campaign_targets column present ${column}`, migration.includes(column));
}

marker.mark("campaign send queue links are additive", migration.includes("ADD COLUMN IF NOT EXISTS campaign_id uuid REFERENCES public.campaigns"));
marker.mark("campaign tables have RLS enabled", migration.includes("ALTER TABLE public.campaigns ENABLE ROW LEVEL SECURITY"));
marker.mark("service role policy exists", migration.includes("campaigns_service_role_all"));
marker.mark("auto-send defaults false", migration.includes("auto_send_enabled boolean DEFAULT false"));
marker.mark("auto-reply defaults disabled", migration.includes("auto_reply_mode text DEFAULT 'disabled'"));

for (const table of [
  "campaign_target_graph",
  "campaign_target_graph_facets",
  "campaign_target_graph_refresh_runs",
]) {
  marker.mark(`graph migration creates ${table}`, graphMigration.includes(`public.${table}`));
}

for (const column of [
  "property_id",
  "property_export_id",
  "master_owner_id",
  "prospect_id",
  "phone_id",
  "canonical_e164",
  "market",
  "state",
  "property_type",
  "canonical_property_group",
  "language",
  "age_bucket",
  "occupation_group",
  "education_model",
  "income",
  "owner_type_guess",
  "priority_tier",
  "rehab_level",
  "sms_eligible",
  "true_post_contact_suppression",
  "wrong_number",
  "pending_prior_touch",
  "active_queue_item",
  "sender_covered",
  "sender_market",
  "timezone",
  "best_phone_score",
  "template_use_case",
  "contact_window",
  "latest_contact_at",
  "last_outbound_at",
  "last_inbound_at",
  "routing_tier",
  "identity_alignment",
  "acquisition_score",
  "podio_tags",
  "matching_flags",
  "queue_eligible",
]) {
  marker.mark(`campaign_target_graph column present ${column}`, graphMigration.includes(column));
}

for (const indexToken of [
  "idx_campaign_target_graph_market",
  "idx_campaign_target_graph_state",
  "idx_campaign_target_graph_property_type",
  "idx_campaign_target_graph_language",
  "idx_campaign_target_graph_priority_tier",
  "idx_campaign_target_graph_sms_eligible",
  "idx_campaign_target_graph_sender_covered",
  "idx_campaign_target_graph_suppression_flags",
  "idx_campaign_target_graph_queue_eligibility",
]) {
  marker.mark(`graph index present ${indexToken}`, graphMigration.includes(indexToken));
}

marker.mark("graph refresh function exists", graphMigration.includes("refresh_campaign_target_graph()"));
marker.mark("facet refresh function exists", graphMigration.includes("refresh_campaign_target_graph_facets()"));
marker.mark("graph tables have RLS enabled", graphMigration.includes("ALTER TABLE public.campaign_target_graph ENABLE ROW LEVEL SECURITY"));
marker.mark("graph service role policy exists", graphMigration.includes("campaign_target_graph_service_role_all"));
marker.mark("preview defaults to graph path", service.includes("previewCampaignTargetsFromGraph") && service.includes("CAMPAIGN_PREVIEW_ALLOW_RUNTIME_EXPANSION"));
marker.mark("build-targets uses graph summary", service.includes("summarizeCampaignGraph") && service.includes("source_view_name: CAMPAIGN_TARGET_GRAPH_TABLE"));
marker.mark("options use precomputed graph facets", catalog.includes("campaign_target_graph_facets") && catalog.includes("queryGraphFacetOptions"));

marker.finish(label);
