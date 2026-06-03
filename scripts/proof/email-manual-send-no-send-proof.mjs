#!/usr/bin/env node

import {
  createFakeSupabase,
  createMarker,
  registerApiAliases,
} from "./email-proof-utils.mjs";

registerApiAliases();

const {
  __resetEmailServiceDeps,
  __setEmailServiceDeps,
  sendManualEmail,
} = await import("@/lib/domain/email/email-service.js");

const marker = createMarker();
const label = "email manual send no-send proof";

const originalEmailSendEnabled = process.env.EMAIL_SEND_ENABLED;
delete process.env.EMAIL_SEND_ENABLED;

let providerCalls = 0;
const fake = createFakeSupabase({
  email_messages: [],
  email_events: [],
  email_suppression: [],
  email_senders: [
    {
      id: "sender_1",
      sender_key: "proof_sender",
      sender_email: "acquisitions@example.com",
      sender_name: "Proof Acquisitions",
      is_active: true,
    },
  ],
  email_identities: [],
});

__setEmailServiceDeps({
  supabase_override: fake,
  send_brevo_override: async () => {
    providerCalls += 1;
    throw new Error("proof should not call Brevo when EMAIL_SEND_ENABLED is false");
  },
  now_iso_override: () => "2026-05-31T12:00:00.000Z",
});

const result = await sendManualEmail({
  to: "seller@example.com",
  from_identity: "proof_sender",
  subject: "Manual proof",
  body: "<p>Manual no-send proof</p>",
  prospect_id: "prospect_1",
  property_id: "property_1",
  master_owner_id: "owner_1",
});

marker.mark("manual send returns ok no-send", result.ok === true && result.no_send === true && result.sent === false);
marker.mark("manual send does not call Brevo provider", providerCalls === 0);
marker.mark("manual send records email_message", fake.rows.email_messages.length === 1);
marker.mark("manual send stores no_send status", fake.rows.email_messages[0]?.status === "no_send");
marker.mark("manual send records email_event", fake.rows.email_events.length === 1);
marker.mark("manual send rejects bulk recipients", (await sendManualEmail({
  to: ["a@example.com", "b@example.com"],
  from_identity: "proof_sender",
  subject: "Bulk proof",
  body: "No bulk",
})).error === "bulk_email_not_allowed");

fake.rows.email_suppression.push({
  email_address: "blocked@example.com",
  reason: "unsubscribed",
  is_active: true,
});

const blocked = await sendManualEmail({
  to: "blocked@example.com",
  from_identity: "proof_sender",
  subject: "Blocked proof",
  body: "Should block",
});

marker.mark("manual send respects suppression", blocked.ok === false && blocked.blocked === true);
marker.mark("suppressed manual send does not call provider", providerCalls === 0);

__resetEmailServiceDeps();
if (originalEmailSendEnabled === undefined) delete process.env.EMAIL_SEND_ENABLED;
else process.env.EMAIL_SEND_ENABLED = originalEmailSendEnabled;

marker.finish(label);
