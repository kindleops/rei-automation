#!/usr/bin/env node
/**
 * brevo-429-probe.mjs
 *
 * ESTABLISHES, FROM EVIDENCE, WHAT A BREVO 429 MEANS.
 *
 * THE QUESTION, precisely.
 *   When Brevo answers a transactional send with HTTP 429, was a message
 *   CREATED? If the request was rejected outright, the send is provably unsent
 *   and safe to repeat after a delay -- delivery_possibility
 *   `definitely_not_sent`, retry_authority `retry_after`. If a message may have
 *   been queued before the limiter answered, acceptance cannot be excluded and
 *   the send must be held.
 *
 * WHY THIS IS NOT ANSWERED FROM THE DOCUMENTATION.
 *   Brevo documents 429 as "too many requests", which is a description of the
 *   status code, not a statement about message creation. EMAIL-1 therefore
 *   classified it conservatively -- `provider_rate_limited`, deliberately
 *   unmapped, landing in the fail-closed ambiguous branch -- and that hold has a
 *   real cost: a rate-limited send stalls instead of backing off. Upgrading it
 *   requires evidence, and the existing SMS mapping refuses to assume the same
 *   thing about TextGrid for exactly this reason.
 *
 * WHAT THIS SCRIPT DOES AND DOES NOT DO.
 *   It records evidence. It does NOT change the classification, and it never
 *   will: an automated script that rewrote a retry policy from its own output
 *   would be deciding a safety question without a human. It writes a report; a
 *   person reads it and decides.
 *
 * IT SENDS REAL API TRAFFIC, so it refuses to run without deliberate opt-in:
 *
 *   BREVO_PROBE_CONFIRM=i-understand-this-sends-real-api-traffic \
 *   BREVO_PROBE_RECIPIENT=you@yourdomain.com \
 *   BREVO_PROBE_SENDER=verified-sender@yourdomain.com \
 *   npm run proof:brevo-429-probe
 *
 *   The recipient MUST be an address you control. The probe deliberately
 *   exceeds a rate limit, so some requests are expected to succeed and actually
 *   deliver before the limiter engages.
 *
 * CREDENTIAL RESOLUTION uses the repository's real convention: a brand key
 * selects BREVO_PROMINENT_API_KEY or BREVO_REIVESTI_API_KEY, falling back to
 * BREVO_API_KEY only when no brand is named.
 */

import fs from "node:fs";
import path from "node:path";

import { resolveBrevoApiKeyForBrand } from "@/lib/email/brevo-client.js";

const CONFIRM_PHRASE = "i-understand-this-sends-real-api-traffic";
const BREVO_SEND_URL = "https://api.brevo.com/v3/smtp/email";

function clean(value) {
  return String(value ?? "").trim();
}

function refuse(reason, guidance) {
  console.log(`SKIP brevo-429-probe: ${reason}`);
  if (guidance) console.log(guidance);
  console.log("");
  console.log("  NOT ESTABLISHED: whether a Brevo 429 creates a message.");
  console.log("  provider_rate_limited therefore remains deliberately unmapped and held.");
  process.exit(0);
}

const confirm = clean(process.env.BREVO_PROBE_CONFIRM);
if (confirm !== CONFIRM_PHRASE) {
  refuse(
    "not confirmed",
    `  This probe sends real requests to Brevo and may deliver real email.\n` +
    `  Re-run with BREVO_PROBE_CONFIRM=${CONFIRM_PHRASE}`
  );
}

const brand_key = clean(process.env.BREVO_PROBE_BRAND) || clean(process.env.EMAIL_DEFAULT_BRAND_KEY);
const api_key = resolveBrevoApiKeyForBrand(brand_key, { allow_legacy_fallback: !brand_key });
if (!api_key) {
  refuse(
    "no Brevo credential is configured",
    "  Set BREVO_PROMINENT_API_KEY or BREVO_REIVESTI_API_KEY (or BREVO_API_KEY for an\n" +
    "  unbranded probe). The key is read server-side and never written to the report."
  );
}

const recipient = clean(process.env.BREVO_PROBE_RECIPIENT);
const sender = clean(process.env.BREVO_PROBE_SENDER);
if (!recipient || !sender) {
  refuse(
    "no probe recipient or sender",
    "  Set BREVO_PROBE_RECIPIENT to an address YOU CONTROL and BREVO_PROBE_SENDER to a\n" +
    "  verified sender on the account. Some requests will succeed and deliver."
  );
}

const burst = Math.max(2, Math.min(Number(process.env.BREVO_PROBE_BURST || 40), 200));
const started_at = new Date().toISOString();

console.log("brevo-429-probe");
console.log(`  burst=${burst} recipient=${recipient} sender=${sender} brand=${brand_key || "(unbranded)"}`);

/** Headers worth keeping. Anything that could carry a credential is excluded. */
const INTERESTING_HEADERS = [
  "retry-after",
  "x-sib-ratelimit-limit",
  "x-sib-ratelimit-remaining",
  "x-sib-ratelimit-reset",
  "ratelimit-limit",
  "ratelimit-remaining",
  "ratelimit-reset",
  "date",
];

async function attempt(index) {
  const body = {
    sender: { email: sender, name: "Rate limit probe" },
    to: [{ email: recipient }],
    subject: `Brevo 429 probe ${index + 1}/${burst} (${started_at})`,
    textContent:
      "Automated rate-limit probe from the Reivesti EMAIL-2 transport work. " +
      "It establishes whether a Brevo 429 creates a message. No action needed.",
    tags: ["email2_rate_limit_probe"],
  };

  const sent_at = new Date().toISOString();
  let response;
  try {
    response = await fetch(BREVO_SEND_URL, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", "api-key": api_key },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return { index, sent_at, transport_error: clean(error?.message) || "network_error" };
  }

  let payload = null;
  try { payload = await response.json(); } catch { payload = null; }

  const headers = {};
  for (const name of INTERESTING_HEADERS) {
    const value = response.headers.get(name);
    if (value) headers[name] = value;
  }

  return {
    index,
    sent_at,
    status: response.status,
    headers,
    // THE decisive field. A 429 that carries a messageId would mean the message
    // was created despite the rate limit, and the conservative hold is correct.
    message_id: clean(payload?.messageId || payload?.message_id) || null,
    provider_code: clean(payload?.code) || null,
    provider_message: clean(payload?.message) || null,
  };
}

// Sequential, not parallel. A parallel burst makes it impossible to say which
// request the limiter saw first, and ordering is half the evidence.
const attempts = [];
for (let index = 0; index < burst; index += 1) {
  const result = await attempt(index);
  attempts.push(result);
  process.stdout.write(result.status === 429 ? "!" : result.status >= 200 && result.status < 300 ? "." : "x");
  if (attempts.filter((a) => a.status === 429).length >= 3) break;
}
process.stdout.write("\n");

const rate_limited = attempts.filter((a) => a.status === 429);
const accepted = attempts.filter((a) => a.message_id);
const with_message_id_on_429 = rate_limited.filter((a) => a.message_id);

const report = {
  probe: "brevo_429_semantics",
  started_at,
  finished_at: new Date().toISOString(),
  burst_requested: burst,
  attempts_made: attempts.length,
  accepted_count: accepted.length,
  rate_limited_count: rate_limited.length,
  rate_limited_carrying_message_id: with_message_id_on_429.length,
  retry_after_seen: rate_limited.some((a) => a.headers?.["retry-after"]),
  attempts,
  // Stated, not concluded. A script does not get to decide a retry policy.
  verdict_requires_human_review: true,
  interpretation_guide: {
    if_no_429_observed:
      "The burst never tripped the limiter. Increase BREVO_PROBE_BURST and re-run; nothing is established.",
    if_429_with_no_message_id:
      "Consistent with the request being rejected outright. Combined with a Brevo dashboard check showing no corresponding message in the transactional log for this window, this supports mapping provider_rate_limited to definitely_not_sent + retry_after using the Retry-After header. Both halves are required.",
    if_429_with_message_id:
      "A message was created despite the 429. The conservative hold is correct and must stay.",
    required_corroboration:
      "Open Brevo > Transactional > Logs for the probe window and count messages with the probe subject. It must equal accepted_count. If it exceeds accepted_count, a rate-limited request created a message and the hold must stay.",
  },
};

const out_dir = path.resolve(process.cwd(), "proof");
fs.mkdirSync(out_dir, { recursive: true });
const out_path = path.join(out_dir, `brevo-429-probe-${started_at.replace(/[:.]/g, "-")}.json`);
fs.writeFileSync(out_path, JSON.stringify(report, null, 2));

console.log("");
console.log(`  attempts            ${attempts.length}`);
console.log(`  accepted (msg id)   ${accepted.length}`);
console.log(`  429 responses       ${rate_limited.length}`);
console.log(`  429 WITH a msg id   ${with_message_id_on_429.length}`);
console.log(`  Retry-After seen    ${report.retry_after_seen ? "yes" : "no"}`);
console.log("");
console.log(`  evidence written to ${out_path}`);
console.log("");
if (!rate_limited.length) {
  console.log("  NOTHING ESTABLISHED: the limiter never engaged. Raise BREVO_PROBE_BURST and re-run.");
} else if (with_message_id_on_429.length) {
  console.log("  A 429 CARRIED A MESSAGE ID. The conservative hold is correct and must stay.");
} else {
  console.log("  No 429 carried a message id. This is HALF the evidence: now check the Brevo");
  console.log("  transactional log for the probe window and confirm the message count equals");
  console.log(`  accepted_count (${accepted.length}). Only then is a reclassification justified.`);
}
