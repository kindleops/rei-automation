const BREVO_TRANSACTIONAL_EMAIL_URL = "https://api.brevo.com/v3/smtp/email";

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function isTrue(value) {
  return ["1", "true", "yes", "on"].includes(lower(value));
}

function asArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (value === null || value === undefined || value === "") return [];
  return [value];
}

function normalizeRecipient(value) {
  if (Array.isArray(value)) {
    if (value.length !== 1) return { ok: false, reason: "bulk_email_not_allowed" };
    return normalizeRecipient(value[0]);
  }

  const email = clean(typeof value === "object" ? value?.email : value).toLowerCase();
  if (!email) return { ok: false, reason: "missing_email" };
  if (email.includes(",") || email.includes(";")) {
    return { ok: false, reason: "bulk_email_not_allowed" };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, reason: "invalid_email" };
  }

  return {
    ok: true,
    recipient: {
      email,
      name: clean(typeof value === "object" ? value?.name : "") || undefined,
    },
  };
}

function envConfig() {
  const sender_email =
    clean(process.env.BREVO_SENDER_EMAIL) ||
    clean(process.env.EMAIL_DEFAULT_SENDER_EMAIL);
  const sender_name =
    clean(process.env.BREVO_SENDER_NAME) ||
    clean(process.env.EMAIL_DEFAULT_SENDER_NAME) ||
    "Acquisitions Team";

  return {
    api_key: clean(process.env.BREVO_API_KEY),
    sender_email,
    sender_name,
    webhook_secret_configured: Boolean(clean(process.env.BREVO_WEBHOOK_SECRET)),
    send_enabled: isTrue(process.env.EMAIL_SEND_ENABLED),
  };
}

export function validateBrevoConfig() {
  const config = envConfig();
  const missing = [];
  if (!config.api_key) missing.push("BREVO_API_KEY");
  if (!config.sender_email) missing.push("BREVO_SENDER_EMAIL");

  return {
    ok: missing.length === 0,
    configured: missing.length === 0,
    send_enabled: config.send_enabled,
    dry_run_default: !config.send_enabled,
    missing,
    sender: {
      name: config.sender_name,
      email: config.sender_email || null,
    },
    webhook_configured: config.webhook_secret_configured,
  };
}

export function normalizeBrevoError(error = {}) {
  const status = Number(error?.status || error?.response?.status || 0) || null;
  const providerCode =
    clean(error?.code) ||
    clean(error?.response?.data?.code) ||
    clean(error?.data?.code);

  if (status === 401 || status === 403) {
    return {
      code: "brevo_unauthorized",
      message: "Email provider authorization failed.",
      retryable: false,
      status,
      provider_code: providerCode || null,
    };
  }

  if (status === 400 || status === 422) {
    return {
      code: providerCode || "brevo_invalid_request",
      message: "Email provider rejected the request.",
      retryable: false,
      status,
      provider_code: providerCode || null,
    };
  }

  if (status === 429) {
    return {
      code: "brevo_rate_limited",
      message: "Email provider rate limit reached.",
      retryable: true,
      status,
      provider_code: providerCode || null,
    };
  }

  if (status && status >= 500) {
    return {
      code: "brevo_provider_unavailable",
      message: "Email provider is temporarily unavailable.",
      retryable: true,
      status,
      provider_code: providerCode || null,
    };
  }

  if (clean(error?.name) === "AbortError") {
    return {
      code: "brevo_timeout",
      message: "Email provider request timed out.",
      retryable: true,
      status,
      provider_code: providerCode || null,
    };
  }

  return {
    code: providerCode || clean(error?.code) || "brevo_send_failed",
    message: clean(error?.message) || "Email provider send failed.",
    retryable: Boolean(error?.retryable),
    status,
    provider_code: providerCode || null,
  };
}

export async function sendBrevoTransactionalEmail(payload = {}, options = {}) {
  const config = envConfig();
  const configStatus = validateBrevoConfig();
  const sendEnabled = options.send_enabled ?? config.send_enabled;
  const dryRun = Boolean(options.dry_run || payload.dry_run || !sendEnabled);

  const recipient = normalizeRecipient(payload.to || payload.recipient || payload.email);
  if (!recipient.ok) {
    return {
      ok: false,
      sent: false,
      dry_run: dryRun,
      reason: recipient.reason,
    };
  }

  const subject = clean(payload.subject);
  const htmlContent = clean(payload.htmlContent || payload.html_body || payload.body_html);
  const textContent = clean(payload.textContent || payload.text_body || payload.body_text);
  const sender = {
    name: clean(payload.sender?.name || payload.sender_name) || config.sender_name,
    email: clean(payload.sender?.email || payload.sender_email) || config.sender_email,
  };
  const replyToEmail = clean(payload.replyTo?.email || payload.reply_to_email);

  if (!subject) {
    return { ok: false, sent: false, dry_run: dryRun, reason: "missing_subject" };
  }
  if (!htmlContent && !textContent) {
    return { ok: false, sent: false, dry_run: dryRun, reason: "missing_body" };
  }
  if (!sender.email) {
    return { ok: false, sent: false, dry_run: dryRun, reason: "sender_identity_missing" };
  }
  if (!configStatus.configured) {
    return {
      ok: false,
      sent: false,
      dry_run: dryRun,
      reason: "brevo_config_missing",
      missing: configStatus.missing,
    };
  }

  const brevoPayload = {
    sender,
    to: [recipient.recipient],
    subject,
    ...(htmlContent ? { htmlContent } : {}),
    ...(textContent ? { textContent } : {}),
    ...(replyToEmail ? { replyTo: { email: replyToEmail } } : {}),
    ...(asArray(payload.tags).length
      ? { tags: asArray(payload.tags).map((tag) => clean(tag).slice(0, 64)).filter(Boolean) }
      : {}),
    ...(payload.params && typeof payload.params === "object" ? { params: payload.params } : {}),
  };

  if (dryRun) {
    return {
      ok: true,
      sent: false,
      dry_run: true,
      no_send: true,
      reason: "email_send_disabled",
      provider: "brevo",
      provider_payload: {
        ...brevoPayload,
        sender: { ...brevoPayload.sender, email: brevoPayload.sender.email },
      },
    };
  }

  const fetchImpl = options.fetch_impl || fetch;
  let response;
  try {
    response = await fetchImpl(BREVO_TRANSACTIONAL_EMAIL_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "api-key": config.api_key,
      },
      body: JSON.stringify(brevoPayload),
      signal: options.signal,
    });
  } catch (error) {
    return {
      ok: false,
      sent: false,
      provider: "brevo",
      error: normalizeBrevoError({ ...error, code: "brevo_network_error", retryable: true }),
    };
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    return {
      ok: false,
      sent: false,
      provider: "brevo",
      error: normalizeBrevoError({
        status: response.status,
        code: clean(data?.code),
        message: clean(data?.message),
      }),
    };
  }

  return {
    ok: true,
    sent: true,
    dry_run: false,
    provider: "brevo",
    message_id: clean(data?.messageId || data?.message_id) || null,
    raw_response: data || {},
  };
}

export async function getBrevoHealth(options = {}) {
  const started = Date.now();
  const config = validateBrevoConfig();

  return {
    ok: true,
    provider: "brevo",
    connected: config.configured,
    api_key_valid: config.configured,
    send_enabled: config.send_enabled,
    dry_run_default: config.dry_run_default,
    missing: config.missing,
    sender_identities: config.sender.email
      ? [
          {
            name: config.sender.name,
            email: config.sender.email,
            active: config.configured,
            domain_verified: "unknown",
          },
        ]
      : [],
    domain_auth_status: "unknown",
    bounce_rate_7d: null,
    send_failure_rate_7d: null,
    api_latency_ms: options.include_latency ? Date.now() - started : null,
    webhook_configured: config.webhook_configured,
    last_checked: new Date().toISOString(),
  };
}

export default {
  sendBrevoTransactionalEmail,
  validateBrevoConfig,
  getBrevoHealth,
  normalizeBrevoError,
};
