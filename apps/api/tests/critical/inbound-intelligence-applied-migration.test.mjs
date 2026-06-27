import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migration_path = path.resolve(
  __dirname,
  "../../supabase/migrations/20260627120000_inbound_intelligence_shadow_mode.sql"
);

test("applied inbound intelligence migration is executable and contains required schema", () => {
  const sql = fs.readFileSync(migration_path, "utf8");
  assert.doesNotMatch(path.basename(migration_path), /^PROPOSED_/);
  assert.match(sql, /seller_contact_referrals/);
  assert.match(sql, /property_participant_graph/);
  assert.match(sql, /uq_seller_contact_referrals_event_phone_property/);
});