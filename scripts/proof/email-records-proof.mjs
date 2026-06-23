#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import {
  API_ROOT,
  createFakeSupabase,
  createMarker,
  registerApiAliases,
} from "./email-proof-utils.mjs";

registerApiAliases();

const {
  __resetEmailServiceDeps,
  __setEmailServiceDeps,
  getEmailRecords,
} = await import("@/lib/domain/email/email-service.js");

const marker = createMarker();
const label = "email records proof";

const migration = fs.readFileSync(
  path.join(API_ROOT, "supabase/migrations/20260531222758_brevo_email_backend_foundation.sql"),
  "utf8"
);

for (const field of [
  "email_rank",
  "email_score",
  "email_match_confidence",
  "verified_status",
  "suppression_status",
  "prospect_id",
  "property_id",
  "master_owner_id",
  "owner_name",
  "property_address",
  "market",
  "language",
  "last_email_sent_at",
  "last_email_reply_at",
]) {
  marker.mark(`records view exposes ${field}`, migration.includes(` AS ${field}`) || migration.includes(field));
}

marker.mark("records view uses security_invoker", migration.includes("WITH (security_invoker = true)"));
marker.mark("records view joins emails", migration.includes("FROM public.emails e"));
marker.mark("records view joins prospects", migration.includes("FROM public.prospects pr"));
marker.mark("records view joins properties", migration.includes("FROM public.properties p"));
marker.mark("records view joins master_owners", migration.includes("public.master_owners mo"));
marker.mark("records view joins contact_outreach_state", migration.includes("public.contact_outreach_state cos"));

const fake = createFakeSupabase({
  v_email_records: [
    {
      id: "email_1",
      email: "seller@example.com",
      email_rank: 1,
      email_score: 92,
      email_match_confidence: "high",
      verified_status: "verified",
      suppression_status: "none",
      prospect_id: "prospect_1",
      property_id: "property_1",
      master_owner_id: "owner_1",
      owner_name: "Proof Owner",
      property_address: "123 Proof St",
      market: "Dallas",
      language: "en",
      last_email_sent_at: null,
      last_email_reply_at: null,
    },
  ],
});

__setEmailServiceDeps({ supabase_override: fake });
const result = await getEmailRecords({ search: "seller", limit: 10 });
__resetEmailServiceDeps();

marker.mark("email records service returns records", result.ok === true && result.records.length === 1);
marker.mark("email record maps recipient email", result.records[0]?.email_address === "seller@example.com");
marker.mark("eligible unsuppressed record stays eligible", result.records[0]?.eligibility === "eligible");

marker.finish(label);
