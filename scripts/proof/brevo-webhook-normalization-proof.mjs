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
  handleBrevoWebhookEvents,
  normalizeEmailEvent,
} = await import("@/lib/domain/email/email-service.js");

const marker = createMarker();
const label = "brevo webhook normalization proof";

const cases = [
  ["delivered", "delivered"],
  ["opened", "opened"],
  ["click", "clicked"],
  ["reply", "replied"],
  ["hard_bounce", "bounced"],
  ["unsubscribed", "unsubscribed"],
  ["spam", "spam"],
  ["blocked", "blocked"],
];

for (const [raw, expected] of cases) {
  const normalized = normalizeEmailEvent({
    event: raw,
    email: "seller@example.com",
    "message-id": "brevo-proof-message",
    date: "2026-05-31T12:00:00.000Z",
  });
  marker.mark(`Brevo ${raw} normalizes to ${expected}`, normalized.event_type === expected);
}

const fake = createFakeSupabase({
  email_events: [],
  email_suppression: [],
  email_messages: [
    {
      id: "message_1",
      thread_id: "thread_1",
      provider_message_id: "brevo-proof-message",
      email_address: "seller@example.com",
      direction: "outbound",
      status: "sent",
      subject: "Proof",
      created_at: "2026-05-31T11:00:00.000Z",
    },
  ],
});

__setEmailServiceDeps({
  supabase_override: fake,
  now_iso_override: () => "2026-05-31T12:00:00.000Z",
});

const result = await handleBrevoWebhookEvents([
  {
    event: "hard_bounce",
    email: "seller@example.com",
    "message-id": "brevo-proof-message",
    reason: "Mailbox unavailable",
    date: "2026-05-31T12:00:00.000Z",
  },
  {
    event: "unsubscribed",
    email: "seller@example.com",
    "message-id": "brevo-proof-message",
    date: "2026-05-31T12:01:00.000Z",
  },
]);

__resetEmailServiceDeps();

marker.mark("webhook handler stores normalized events", result.events_received === 2 && fake.rows.email_events.length === 2);
marker.mark("webhook handler updates message status", ["bounced", "unsubscribed"].includes(fake.rows.email_messages[0]?.status));
marker.mark("webhook handler writes suppression", fake.rows.email_suppression.length === 1);
marker.mark("suppression reason respects unsubscribe latest upsert", fake.rows.email_suppression[0]?.reason === "unsubscribed");

marker.finish(label);
