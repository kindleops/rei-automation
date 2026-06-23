import { execSync } from 'child_process';
import fs from 'fs';

const objects = [
  // Extracted from above output
  "email_events", "import_log", "inbox_messages_hydrated", "conversation_memory", "active_negotiations",
  "ownership_check_template_kpis", "email_queue", "sms_template_kpis", "email_templates",
  "campaign_target_graph_facets", "campaign_touch_plan", "textgrid_numbers", "textgrid_numbers_dashboard",
  "campaign_targets", "email_senders", "buyer_purchase_events_v2", "message_events", "webhook_log",
  "send_queue", "buyer_entities_v2", "inbox_chat_timeline_hydrated", "template_number_combo_kpis_v",
  "deduped_message_events", "campaign_target_graph_stage", "wire_events", "property_cash_offer_snapshots",
  "wire_accounts", "ops_notifications", "campaign_approval_requests", "ops_recommendations",
  "discord_action_audit", "census_geo_metrics", "operator_thread_state", "market_routing_rules",
  "census_sync_runs", "buyer_activity_geo_rollups", "map_layer_cache", "state_geo_bounds",
  "notification_watchlist", "smart_inbox_views", "import_manifest", "campaigns", "campaign_filters",
  "prospects", "master_owners", "command_notifications", "deal_marker_taxonomy", "emails",
  "sub_owners", "campaign_send_windows", "campaign_runs", "campaign_events", "system_control",
  "campaign_daily_limits", "template_performance_kpis_v", "number_performance_kpis_v",
  "queue_validation_results_v", "negotiation_events", "seller_state_snapshots", "v_property_map_points_live",
  "nexus_thread_messages_v", "nexus_queue_health_v", "nexus_notifications_v", "nexus_map_points_v",
  "thread_resolution_queue", "agent_attribution_metrics_v", "routing_decisions", "agent_performance_kpis_v",
  "agent_actions", "seller_heat_scores", "inbox_thread_state", "daily_goal_targets", "thread_ai_state",
  "message_attribution_events_v", "human_escalations", "queue_command_center_v", "ai_decisions",
  "live_conversation_metrics", "conversation_threads", "conversation_turns", "follow_up_queue",
  "v_nexus_active_dashboard", "supabase_upload_log", "top_buyer_profiles", "top_buyer_property_matches",
  "recently_sold_properties", "buyer_activity", "buyer_profiles", "corporate_owner_rollups",
  "v_buyer_comp_clean_v2", "buyer_property_matches", "buyer_comp_import_batches_v2",
  "buyer_contact_enrichment_jobs_v2", "buyer_contacts_v2", "automation_suppressions",
  "recently_sold_properties_computed", "buyer_profiles_computed", "buyer_property_matches_computed",
  "buyer_comp_properties_v2", "inbox_activity_events", "automation_rules", "performance_message_events_v",
  "inbox_threads_hydrated", "inbox_thread_dossier_hydrated", "inbox_command_center_v",
  "campaign_target_graph_refresh_runs", "campaign_target_graph", "automation_events",
  "pipeline_cards_view", "buyer_property_matches_v2", "buyer_geo_rollups_v2", "map_markers_view",
  "notification_feed_view", "inbox_threads_view", "conversation_detail_view", "v_buyer_comp_formula_v2",
  "ownership_template_rotation_control", "deal_intelligence_view", "v_ownership_template_rotation_control",
  "list_rows_view", "automation_runs", "property_acquisition_scores", "automation_actions",
  "automation_audit_log", "buyer_comp_raw_v2", "v_buyer_entities_from_comps", "v_buyer_entity_leaderboard",
  "v_universal_lead_command", "v_inbox_enriched", "v_buyer_entity_purchases", "inbox_category_counts",
  "campaign_target_graph_refresh_batches", "inbox_thread_state_thread_key_repair_backup_20260519",
  "v_seller_work_items", "v_command_map_seller_pin_feed", "v_recent_sold_comps",
  "message_events_thread_key_repair_backup_20260519", "send_queue_thread_key_repair_backup_20260519",
  "property_valuation_snapshots", "v_market_fresh_inventory", "sms_templates", "v_property_lead_command",
  "v_sms_campaign_queue_candidates", "v_outbound_candidate_freshness", "v_outbound_discovery_fresh",
  "v_candidate_exhaustion_metrics", "v_template_coverage_audit", "v_outbound_discovery_open_now",
  "contact_outreach_state", "outbound_identity_quarantine", "v_identity_guard_metrics",
  "outbound_candidate_snapshot", "sms_suppression_list", "phones", "v_sms_ready_contacts_expanded",
  "nexus_inbox_threads_v", "v_sms_ready_contacts", "v_sms_ready_contacts_clean", "sms_campaigns",
  "sms_campaign_targets", "v_operator_inbox_threads", "buyer_entities", "buyer_purchase_events",
  "v_buyer_property_matches_unified", "buyer_match_runs", "buyer_match_candidates",
  "property_universe_state", "deal_thread_state", "v_map_property_pins", "workflows", "workflow_steps",
  "workflow_template_sets", "workflow_template_variants", "workflow_template_translations",
  "v_universal_inbox_threads", "workflow_sender_pools", "workflow_sender_pool_members", "workflow_runs",
  "workflow_run_events", "workflow_audit_log", "deal_context_index", "v_deal_context_cards",
  "v_inbox_thread_counts_live_v2", "v_inbox_threads_live_v2", "v_feeder_candidates_fast",
  "outbound_feeder_candidates", "canonical_inbox_threads", "canonical_inbox_counts", "properties",
  "rei_import_batches_v1", "rei_lead_raw_v1", "workflow_definitions", "workflow_nodes", "workflow_edges",
  "workflow_enrollments", "workflow_run_steps", "universal_lead_command_cache", "workflow_events",
  "workflow_node_registry",
  
  // Functions
  "automation_touch_updated_at", "backfill_campaign_target_graph_filter_columns_batch",
  "backfill_campaign_target_graph_stage_filter_columns_batch", "bulk_import_templates", "calc_deal_grade",
  "calc_rehab_level", "calc_sqft_range", "calc_year_bucket", "campaign_age_bucket_from_mob",
  "campaign_enqueue_next_touch", "campaign_target_graph_apply_filter_columns", "campaign_target_graph_text_to_bool",
  "campaign_target_graph_text_to_numeric", "campaign_touch_allowed", "campaign_touch_updated_at",
  "claim_queue_jobs", "generate_buyer_key_etl", "get_auto_reply_template_id", "get_available_numbers_count",
  "get_buyer_match_candidates", "get_buyers_for_property", "get_canonical_property_group",
  "get_command_map_seller_pins", "get_comp_candidates_for_subject", "get_inbox_thread_dossier",
  "get_next_queued_message", "get_number_rotation_stats", "get_or_create_conversation",
  "get_ownership_check_template_stats", "get_ownership_check_template_stats_v2", "get_property_coordinates",
  "get_recent_sold_comps_in_bounds", "get_sms_template_stats", "get_thread_enrichment", "handle_updated_at",
  "increment_outreach_touch_count", "intel_clean_price", "intel_haversine_miles", "intel_normalize_asset_class",
  "intel_normalize_market", "intel_normalize_state", "intel_normalize_zip", "log_message_event",
  "mark_job_failed", "mark_job_sent", "mark_message_sent", "nexus_inbox_priority_classify",
  "normalize_asset_class_etl", "normalize_buyer_entity_name", "normalize_buyer_entity_text",
  "normalize_buyer_name_etl", "normalize_campaign_sender_market", "normalize_campaign_sender_phone",
  "normalize_phone", "populate_buyer_entities_from_sold_data", "reap_stale_campaign_target_graph_refresh_runs",
  "rebuild_buyer_geo_rollups", "refresh_campaign_target_graph", "refresh_campaign_target_graph_facets",
  "refresh_campaign_target_graph_fallback_batch", "refresh_campaign_target_graph_property_universe_batch",
  "refresh_campaign_target_graph_sender_coverage", "refresh_campaign_target_graph_stage_batch",
  "refresh_campaign_target_graph_stage_commit", "refresh_campaign_target_graph_stage_start",
  "refresh_campaign_target_graph_staged", "refresh_deal_context_index", "refresh_universal_lead_command_cache",
  "reset_textgrid_daily_usage", "resolve_campaign_safe_sender_route", "resolve_thread_key", "safe_divide",
  "select_available_number", "set_email_senders_updated_at", "set_email_templates_updated_at",
  "set_sms_templates_updated_at", "set_updated_at", "touch_inbox_thread_state_updated_at",
  "touch_updated_at", "unlock_stale_jobs", "update_conversation_stats", "update_notification_watchlist_updated_at",
  "update_timestamp", "update_updated_at_column", "workflow_touch_updated_at"
];

const results = {};
const unreferenced = [];

console.log(`Auditing ${objects.length} objects...`);

for (const obj of objects) {
  try {
    // Only match whole words (\b)
    const cmd = `rg -l "\\b${obj}\\b" apps scripts docs --glob '!schema_dump.*' --glob '!schema_dump*' --glob '!*audit*' --glob '!supabase/migrations/*'`;
    const output = execSync(cmd, { encoding: 'utf-8' });
    const files = output.trim().split('\n').filter(Boolean);
    results[obj] = files;
  } catch (err) {
    // ripgrep exits with 1 if no matches are found
    if (err.status === 1) {
      results[obj] = [];
      unreferenced.push(obj);
    } else {
      console.error(`Error processing ${obj}: ${err.message}`);
    }
  }
}

fs.writeFileSync('audit_results.json', JSON.stringify({ results, unreferenced }, null, 2));

console.log(`Found ${unreferenced.length} completely unreferenced objects in app code.`);
console.log('Done.');
