#!/usr/bin/env node

import { createMarker, registerApiAliases } from "./email-proof-utils.mjs";

registerApiAliases();

const {
  getBrevoHealth,
  sendBrevoTransactionalEmail,
  validateBrevoConfig,
} = await import("@/lib/domain/email/brevo-provider.js");

const marker = createMarker();
const label = "brevo config proof";

const originalEnv = {
  BREVO_API_KEY: process.env.BREVO_API_KEY,
  BREVO_SENDER_EMAIL: process.env.BREVO_SENDER_EMAIL,
  BREVO_SENDER_NAME: process.env.BREVO_SENDER_NAME,
  EMAIL_SEND_ENABLED: process.env.EMAIL_SEND_ENABLED,
};

process.env.BREVO_API_KEY = "proof-brevo-key";
process.env.BREVO_SENDER_EMAIL = "sender@example.com";
process.env.BREVO_SENDER_NAME = "Proof Sender";
delete process.env.EMAIL_SEND_ENABLED;

let fetchCalled = false;
const config = validateBrevoConfig();
const health = await getBrevoHealth();
const result = await sendBrevoTransactionalEmail(
  {
    to: "owner@example.com",
    subject: "Proof no-send",
    htmlContent: "<p>Proof only</p>",
  },
  {
    fetch_impl: async () => {
      fetchCalled = true;
      throw new Error("proof should not call Brevo");
    },
  }
);

marker.mark("Brevo config validates when required env is present", config.ok);
marker.mark("EMAIL_SEND_ENABLED defaults to dry-run", config.dry_run_default === true && config.send_enabled === false);
marker.mark("Brevo health reports webhook status without remote send", health.ok === true && health.provider === "brevo");
marker.mark("provider returns no-send response while disabled", result.ok === true && result.no_send === true && result.sent === false);
marker.mark("provider did not call fetch in no-send mode", fetchCalled === false);

for (const [key, value] of Object.entries(originalEnv)) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

marker.finish(label);
