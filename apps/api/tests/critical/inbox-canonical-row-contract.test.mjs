import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

import {
  resolveContactIdentityClass,
  contactIdentityLabel,
  isSellerIntentIdentity,
} from "../../src/lib/domain/inbox/contact-identity.js";
import {
  CANONICAL_INBOX_ROW_SELECT_FIELDS,
  CANONICAL_INBOX_COUNT_KEYS,
  INBOX_THREAD_SUMMARY_SELECT_FIELDS,
  buildEnrichmentCoverageDiagnostics,
  compactInboxThreadSummaryRow,
} from "../../src/lib/domain/inbox/canonical-inbox-row-contract.js";
import { getLiveInbox } from "../../src/lib/domain/inbox/live-inbox-service.js";
import { makeLiveInboxThreadSupabase, buildInboxCountRowFromThreads } from "../helpers/chainable-supabase.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIVE_ROUTE_SRC = readFileSync(
  resolve(__dirname, "../../src/app/api/cockpit/inbox/live/route.js"),
  "utf8",
);
const INBOX_PAGE_SRC = readFileSync(
  resolve(__dirname, "../../../dashboard/src/modules/inbox/InboxPage.tsx"),
  "utf8",
);
const INBOX_ROUTE_SRC = readFileSync(
  resolve(__dirname, "../../../dashboard/src/app/routes.tsx"),
  "utf8",
);
const KPI_ORB_SRC = readFileSync(
  resolve(__dirname, "../../../dashboard/src/modules/inbox/components/InboxKpiOrb.tsx"),
  "utf8",
);

test("contact identity classification covers operator buckets", () => {
  assert.equal(resolveContactIdentityClass({ wrong_number: true }), "wrong_number");
  assert.equal(resolveContactIdentityClass({ detected_intent: "wrong_person" }), "wrong_person");
  assert.equal(resolveContactIdentityClass({ detected_intent: "renter_occupant" }), "renter_occupant");
  assert.equal(resolveContactIdentityClass({ detected_intent: "ownership_confirmed" }), "confirmed_owner");
  assert.equal(resolveContactIdentityClass({ master_owner_id: "mo-1", property_id: "p-1" }), "probable_owner");
  assert.equal(resolveContactIdentityClass({ master_owner_id: "mo-1" }), "owner_related_contact");
  assert.equal(resolveContactIdentityClass({}), "unknown");
  assert.equal(contactIdentityLabel("confirmed_owner"), "Confirmed Owner");
  assert.equal(isSellerIntentIdentity("wrong_person"), false);
  assert.equal(isSellerIntentIdentity("confirmed_owner"), true);
});

test("canonical row contract includes required enrichment fields", () => {
  for (const field of [
    "thread_key",
    "owner_name",
    "property_address_full",
    "market",
    "property_type",
    "estimated_value",
    "equity_amount",
    "equity_percent",
    "acquisition_stage",
    "contact_identity_class",
    "property_flags_text",
    "tax_delinquent",
    "active_lien",
    "unread_count",
    "latest_message_body",
  ]) {
    assert.match(CANONICAL_INBOX_ROW_SELECT_FIELDS, new RegExp(field));
  }
  for (const key of ["needs_attention", "qualified", "wrong_person", "unread", "all_messages"]) {
    assert.ok(CANONICAL_INBOX_COUNT_KEYS.includes(key), `missing count key ${key}`);
  }
});

test("inbox summary contract includes property distress badge fields", () => {
  for (const field of [
    "property_flags_text",
    "tax_delinquent",
    "active_lien",
    "building_condition",
    "equity_percent",
    "property_type",
    "matching_flags",
    "person_flags_text",
  ]) {
    assert.match(INBOX_THREAD_SUMMARY_SELECT_FIELDS, new RegExp(field), `missing summary field ${field}`);
  }
});

test("compact inbox summary row preserves distress badge fields", () => {
  const compact = compactInboxThreadSummaryRow({
    thread_key: "+15550001111",
    property_flags_text: "Tax Delinquent; Tired Landlord",
    tax_delinquent: true,
    active_lien: false,
    building_condition: "Dated",
    equity_percent: 62,
    property_type: "SFR",
    matching_flags: "Likely Owner",
    person_flags_text: "Family",
    contact_identity_class: "probable_owner",
  });
  assert.equal(compact.property_flags_text, "Tax Delinquent; Tired Landlord");
  assert.equal(compact.tax_delinquent, true);
  assert.equal(compact.active_lien, false);
  assert.equal(compact.building_condition, "Dated");
  assert.equal(Number(compact.equity_percent), 62);
  assert.equal(compact.property_type, "SFR");
  assert.equal(compact.matching_flags, "Likely Owner");
  assert.equal(compact.person_flags_text, "Family");
  assert.equal(compact.contact_identity_class, "probable_owner");
});

test("enrichment coverage diagnostics stay dev-only signal shape", () => {
  const diagnostics = buildEnrichmentCoverageDiagnostics({
    property_id: "p-1",
    property_address_full: "123 Main St",
    master_owner_id: "mo-1",
    owner_name: "Jane Seller",
    market: "Dallas",
    estimated_value: 250000,
    inbox_bucket: "new_replies",
    latest_message_body: "Interested",
    latest_message_at: "2026-06-24T12:00:00.000Z",
    contact_identity_class: "probable_owner",
  });
  assert.equal(diagnostics.property_resolved, true);
  assert.equal(diagnostics.owner_resolved, true);
  assert.equal(diagnostics.market_resolved, true);
  assert.equal(diagnostics.valuation_resolved, true);
  assert.equal(diagnostics.classification_resolved, true);
  assert.equal(diagnostics.message_history_resolved, true);
  assert.equal(diagnostics.contact_identity_resolved, true);
});

test("initial boot uses canonical row contract without skip flags", () => {
  assert.doesNotMatch(LIVE_ROUTE_SRC, /skip_counts\s*=\s*'true'/);
  assert.doesNotMatch(LIVE_ROUTE_SRC, /skip_delivery\s*=\s*'true'/);
  assert.doesNotMatch(LIVE_ROUTE_SRC, /initial_boot_safe/);
  assert.match(INBOX_PAGE_SRC, /resolveCanonicalThreadStateKey/);
});

test("deal desk opens 25/50/25 by default", () => {
  assert.match(INBOX_PAGE_SRC, /thread:\s*'25'/);
  assert.match(INBOX_PAGE_SRC, /sms_thread:\s*'50'/);
  assert.match(INBOX_PAGE_SRC, /deal_intelligence:\s*'25'/);
  assert.match(INBOX_PAGE_SRC, /DEAL_DESK_LAYOUT_VERSION/);
  assert.match(INBOX_PAGE_SRC, /isDealDeskLayout/);
  assert.match(INBOX_PAGE_SRC, /isCustomMultiView = isMultiView && isDealDeskLayout/);
  assert.match(INBOX_ROUTE_SRC, /<InboxView routeMode="workspace" \/>/);
  assert.doesNotMatch(INBOX_ROUTE_SRC, /path: '\/inbox'[\s\S]*initialWorkspaceView="thread"/);
});

test("KPI hover cards omit engineering diagnostics strip", () => {
  assert.doesNotMatch(KPI_ORB_SRC, /Metrics Data Source/);
  assert.doesNotMatch(KPI_ORB_SRC, /metric_source_debug/);
  assert.doesNotMatch(KPI_ORB_SRC, /Source Tables/);
});

test("getLiveInbox trusts bucket-scoped SQL for manual bucket switch", async () => {
  const threadRows = [
    {
      thread_key: "+15550001111",
      canonical_thread_key: "+15550001111",
      inbox_bucket: "new_replies",
      latest_message_direction: "inbound",
      latest_message_at: "2026-06-29T12:00:00.000Z",
      is_read: true,
      property_id: "p-1",
      seller_phone: "+15550001111",
      owner_name: "Read New Reply Seller",
      property_address_full: "11 Reply Ave",
      property_flags_text: "High Equity",
      contact_identity_class: "confirmed_owner",
      latest_message_body: "Already read but still bucketed new_replies",
    },
    {
      thread_key: "+15550002222",
      canonical_thread_key: "+15550002222",
      inbox_bucket: "priority",
      latest_message_direction: "inbound",
      latest_message_at: "2026-06-29T11:00:00.000Z",
      is_read: true,
      property_id: "p-2",
      seller_phone: "+15550002222",
      owner_name: "Priority Seller",
      property_address_full: "22 Priority Blvd",
      property_flags_text: "Tax Delinquent",
      contact_identity_class: "probable_owner",
      latest_message_body: "Priority seller",
    },
  ];
  const supabase = makeLiveInboxThreadSupabase(threadRows, {
    countRows: [buildInboxCountRowFromThreads(threadRows)],
  });

  const newReplies = await getLiveInbox(
    { filter: "new_replies", timeout_mode: "manual_bucket_switch", limit: 25, skip_counts: true },
    { supabase },
  );
  const priority = await getLiveInbox(
    { filter: "priority", timeout_mode: "manual_bucket_switch", limit: 25, skip_counts: true },
    { supabase },
  );

  assert.ok(newReplies.threads.length >= 1, "bucket-scoped new_replies query must not drop read rows");
  assert.ok(
    newReplies.threads.some((row) => row.thread_key === "+15550001111"),
    "expected persisted new_replies row to survive bucket query",
  );
  assert.equal(priority.threads.length, 1, "bucket-scoped priority query must return priority rows");
  const priorityRow = priority.threads[0];
  assert.equal(priorityRow.seller_phone, "+15550002222", "bucket tab rows must include seller phone from authoritative state");
  assert.equal(priorityRow.latest_message_body, "Priority seller", "bucket tab rows must include latest message preview");
  assert.equal(priorityRow.inbox_bucket, "priority", "bucket tab rows must preserve authoritative inbox_bucket");
});

test("getLiveInbox returns fast boot rows from inbox_thread_state for initial boot", async () => {
  const stateRows = [
    {
      thread_key: "+15550001111",
      canonical_e164: "+15550001111",
      seller_phone: "+15550001111",
      inbox_bucket: "new_replies",
      latest_message_body: "Yes I am interested",
      latest_message_at: "2026-06-24T12:00:00.000Z",
      latest_direction: "inbound",
      unread_count: 1,
      property_id: "p-1",
      master_owner_id: "mo-1",
      market: "Dallas",
    },
  ];
  const supabase = makeLiveInboxThreadSupabase([], {
    stateRows,
    countRows: [buildInboxCountRowFromThreads(stateRows.map((row) => ({
      ...row,
      latest_message_direction: row.latest_direction,
    })))],
  });

  const result = await getLiveInbox(
    { filter: "all", timeout_mode: "initial_boot", limit: 25, skip_counts: "1", skip_delivery: "1" },
    { listOnly: true, skipCounts: true, skipDelivery: true },
    { supabase },
  );

  assert.equal(result.threads.length, 1);
  const row = result.threads[0];
  assert.equal(row.seller_phone, "+15550001111");
  assert.equal(row.latest_message_body, "Yes I am interested");
  assert.equal(row.inbox_bucket, "new_replies");
  assert.equal(row.market, "Dallas");
  assert.equal(result.source, "inbox_thread_state");
  assert.equal(result.countsSource, "skipped");
});