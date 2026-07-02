import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  buildTextgridConfigurationError,
  getTextgridProviderReadiness,
  loadTextgridConfig,
  resetTextgridConfigCache,
} from "@/lib/config/textgrid-config.js";
import { sendTextgridSMS } from "@/lib/providers/textgrid.js";
import { primeSystemControlCache } from "@/lib/system-control.js";

const saved_sid = process.env.TEXTGRID_ACCOUNT_SID;
const saved_token = process.env.TEXTGRID_AUTH_TOKEN;

afterEach(() => {
  resetTextgridConfigCache();
  if (typeof saved_sid === "string") {
    process.env.TEXTGRID_ACCOUNT_SID = saved_sid;
  } else {
    delete process.env.TEXTGRID_ACCOUNT_SID;
  }
  if (typeof saved_token === "string") {
    process.env.TEXTGRID_AUTH_TOKEN = saved_token;
  } else {
    delete process.env.TEXTGRID_AUTH_TOKEN;
  }
});

test("loadTextgridConfig: reads canonical TEXTGRID_* env names", () => {
  process.env.TEXTGRID_ACCOUNT_SID = "AC-canonical-sid";
  process.env.TEXTGRID_AUTH_TOKEN = "canonical-token";
  resetTextgridConfigCache();

  const config = loadTextgridConfig();
  assert.equal(config.account_sid, "AC-canonical-sid");
  assert.equal(config.auth_token, "canonical-token");
  assert.equal(config.configured, true);
  assert.deepEqual(config.missing, []);
});

test("loadTextgridConfig: supports TEXTGRID_API_KEY alias for auth token", () => {
  delete process.env.TEXTGRID_AUTH_TOKEN;
  process.env.TEXTGRID_ACCOUNT_SID = "AC-alias-sid";
  process.env.TEXTGRID_API_KEY = "alias-token";
  resetTextgridConfigCache();

  const config = loadTextgridConfig();
  assert.equal(config.auth_token, "alias-token");
  assert.equal(config.configured, true);
});

test("getTextgridProviderReadiness: returns booleans without secret values", () => {
  process.env.TEXTGRID_ACCOUNT_SID = "AC-readiness";
  process.env.TEXTGRID_AUTH_TOKEN = "token-readiness";
  process.env.TEXTGRID_WEBHOOK_SECRET = "webhook-secret";
  resetTextgridConfigCache();

  const readiness = getTextgridProviderReadiness();
  assert.equal(readiness.provider, "textgrid");
  assert.equal(readiness.configured, true);
  assert.equal(readiness.account_sid_present, true);
  assert.equal(readiness.auth_token_present, true);
  assert.equal(readiness.sending_identity_configured, true);
  assert.equal(readiness.webhook_configured, true);
  assert.equal(JSON.stringify(readiness).includes("token-readiness"), false);
});

test("buildTextgridConfigurationError: omits secret names from user-facing message", () => {
  const error = buildTextgridConfigurationError({
    configured: false,
    missing: ["TEXTGRID_ACCOUNT_SID", "TEXTGRID_AUTH_TOKEN"],
  });
  assert.equal(error.code, "provider_configuration_missing");
  assert.match(error.message, /not configured/i);
  assert.equal(error.message.includes("TEXTGRID_ACCOUNT_SID"), false);
});

test("sendTextgridSMS: throws safe configuration error when credentials missing", async () => {
  delete process.env.TEXTGRID_ACCOUNT_SID;
  delete process.env.TEXTGRID_AUTH_TOKEN;
  resetTextgridConfigCache();
  primeSystemControlCache("outbound_sms_enabled", true);

  await assert.rejects(
    () =>
      sendTextgridSMS({
        to: "+15550001111",
        from: "+15550002222",
        body: "Hello seller",
        bypass_system_control: true,
      }),
    (error) => {
      assert.match(error.message, /not configured/i);
      assert.equal(error.message.includes("TEXTGRID_ACCOUNT_SID"), false);
      assert.equal(error.data?.code, "provider_configuration_missing");
      return true;
    }
  );
});