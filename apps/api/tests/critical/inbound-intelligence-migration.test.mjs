import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migration_path = path.resolve(
  __dirname,
  "../../supabase/migrations/PROPOSED_20260625143000_inbound_intelligence_shadow_mode.sql"
);

test("proposed migration remains non-executable and contains required schema elements", () => {
  const sql = fs.readFileSync(migration_path, "utf8");
  assert.match(path.basename(migration_path), /^PROPOSED_/);
  assert.match(sql, /inbound_intelligence_audit/);
  assert.match(sql, /seller_contact_referrals/);
  assert.match(sql, /property_participant_graph/);
  assert.doesNotMatch(sql, /CREATE\s+MATERIALIZED\s+VIEW\s+.*property_participant_graph_mv/i);
  assert.match(sql, /uq_inbound_intelligence_audit_source_event_unique|source_event_unique/);
  assert.match(sql, /uq_seller_contact_referrals_event_phone_property/);
  assert.match(sql, /uq_seller_contact_referrals_event_name_property/);
  assert.match(sql, /suppression_scope/);
  assert.match(sql, /shadow_comparison/);
  assert.match(sql, /replay_version/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /service_role_all_inbound_intelligence_audit/);
  assert.match(sql, /deny_anon_all_inbound_intelligence_audit/);
  assert.match(sql, /deny_authenticated_select_inbound_intelligence_audit/);
  assert.match(sql, /deny_authenticated_select_seller_contact_referrals/);
  assert.match(sql, /deny_authenticated_insert_seller_contact_referrals/);
  assert.match(sql, /deny_authenticated_update_seller_contact_referrals/);
  assert.doesNotMatch(sql, /authenticated_read_seller_contact_referrals/);
  assert.doesNotMatch(sql, /ON DELETE CASCADE.*inbound_intelligence_audit/i);
});

test("property participant graph contract remains read-only projection", async () => {
  const { PROPERTY_PARTICIPANT_FIELDS, normalizePropertyParticipantRow } = await import(
    "@/lib/domain/inbox/property-participant-graph.js"
  );
  assert.ok(PROPERTY_PARTICIPANT_FIELDS.includes("suppression_scope"));
  assert.ok(PROPERTY_PARTICIPANT_FIELDS.includes("identity_class"));
  const row = normalizePropertyParticipantRow({
    participant_id: "p1",
    property_id: "100",
    canonical_e164: "+15551234567",
    identity_class: "respondent_non_owner",
    suppression_scope: "property",
    safe_to_contact: true,
  });
  assert.equal(row.suppression_scope, "property");
  assert.equal(row.safe_to_contact, true);
});