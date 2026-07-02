import ENV from "@/lib/config/env.js";

const CANONICAL_ENV_KEYS = Object.freeze({
  account_sid: "TEXTGRID_ACCOUNT_SID",
  auth_token: "TEXTGRID_AUTH_TOKEN",
  webhook_secret: "TEXTGRID_WEBHOOK_SECRET",
  api_base_url: "TEXTGRID_API_BASE_URL",
  status_callback_enabled: "TEXTGRID_STATUS_CALLBACK_ENABLED",
});

const ACCOUNT_SID_ALIASES = ["TEXTGRID_ACCOUNT_SID", "textgrid_account_sid"];
const AUTH_TOKEN_ALIASES = [
  "TEXTGRID_AUTH_TOKEN",
  "textgrid_auth_token",
  "TEXTGRID_API_KEY",
  "textgrid_api_key",
];
const WEBHOOK_SECRET_ALIASES = ["TEXTGRID_WEBHOOK_SECRET", "textgrid_webhook_secret"];

let validated_config = null;

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function asBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  const normalized = lower(value);
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function readFirstPresent(env, aliases = []) {
  for (const key of aliases) {
    const from_env = clean(env?.[key]);
    if (from_env) {
      return { value: from_env, source_key: key };
    }
  }
  return { value: "", source_key: null };
}

function resolveAppBaseUrl(env = process.env) {
  return clean(ENV.APP_BASE_URL || env.APP_BASE_URL || env.VERCEL_URL && `https://${clean(env.VERCEL_URL)}`);
}

export function loadTextgridConfig(env = process.env) {
  const account = readFirstPresent(env, ACCOUNT_SID_ALIASES);
  const auth = readFirstPresent(env, AUTH_TOKEN_ALIASES);
  const webhook = readFirstPresent(env, WEBHOOK_SECRET_ALIASES);
  const api_base_url = clean(ENV.TEXTGRID_API_BASE_URL || env.TEXTGRID_API_BASE_URL);
  const status_callback_enabled =
    ENV.TEXTGRID_STATUS_CALLBACK_ENABLED === true ||
    asBoolean(env.TEXTGRID_STATUS_CALLBACK_ENABLED, false);
  const app_base_url = resolveAppBaseUrl(env);

  const missing = [];
  if (!account.value) missing.push(CANONICAL_ENV_KEYS.account_sid);
  if (!auth.value) missing.push(CANONICAL_ENV_KEYS.auth_token);

  return {
    account_sid: account.value,
    auth_token: auth.value,
    webhook_secret: webhook.value,
    api_base_url,
    status_callback_enabled,
    app_base_url,
    configured: missing.length === 0,
    missing,
    source_keys: {
      account_sid: account.source_key,
      auth_token: auth.source_key,
      webhook_secret: webhook.source_key,
    },
  };
}

export function getValidatedTextgridConfig(env = process.env) {
  if (!validated_config) {
    validated_config = loadTextgridConfig(env);
  }
  return validated_config;
}

export function resetTextgridConfigCache() {
  validated_config = null;
}

export function getTextgridProviderReadiness(env = process.env) {
  const config = loadTextgridConfig(env);
  const webhook_configured = Boolean(config.webhook_secret);
  const status_callback_configured =
    !config.status_callback_enabled || Boolean(config.app_base_url);

  return {
    provider: "textgrid",
    configured: config.configured,
    account_sid_present: Boolean(config.account_sid),
    auth_token_present: Boolean(config.auth_token),
    sending_identity_configured: config.configured,
    webhook_configured,
    status_callback_enabled: config.status_callback_enabled,
    status_callback_configured,
    missing: config.missing,
    base_url_present: Boolean(config.api_base_url),
    app_base_url_present: Boolean(config.app_base_url),
  };
}

export function buildTextgridConfigurationError(config = loadTextgridConfig()) {
  return {
    code: "provider_configuration_missing",
    message: "SMS provider is not configured on the server.",
    provider: "textgrid",
    missing: config.missing,
    configured: config.configured,
  };
}

export { CANONICAL_ENV_KEYS };