/**
 * SENDER ROUTING 2.0 — provider inventory truth (owner brief §B). READ-ONLY.
 *
 * Reconciles the provider's number list (TextGrid IncomingPhoneNumbers, read
 * with GET only, or the owner's pasted console inventory) against
 * public.textgrid_numbers. Pure: callers supply both sides.
 *
 * States (one per phone):
 *   PROVIDER_ONLY    on the provider, no local record
 *   LOCAL_ONLY       local record, not on the provider (stale / released)
 *   MATCHED          both, consistent
 *   CONFIG_MISMATCH  both, but registration / webhook / local hold disagree
 * Flags (any number): webhook_missing, registration_incomplete, paused_locally,
 *   operator_blocked, inbound_unverified, duplicate_local, friendly_name_differs,
 *   registration_unrecorded_locally.
 *
 * Webhook state is never pretended: VERIFIED only with evidence that inbound
 * SMS actually reached LeadCommand on that number (message_events history or
 * a recorded inbound round-trip proof); CONFIGURED_UNVERIFIED when the provider
 * points at our inbound URL but nothing has arrived; MISSING when the provider
 * has no / a foreign SMS URL; UNKNOWN when the provider side was not read.
 */

import { deriveLifecycleState, maskPhone, normalizeE164 } from "./sender-routing-policy.js";

export const INVENTORY_STATES = Object.freeze({
  PROVIDER_ONLY: "PROVIDER_ONLY",
  LOCAL_ONLY: "LOCAL_ONLY",
  MATCHED: "MATCHED",
  CONFIG_MISMATCH: "CONFIG_MISMATCH",
});

export const WEBHOOK_STATES = Object.freeze({
  VERIFIED: "VERIFIED",
  CONFIGURED_UNVERIFIED: "CONFIGURED_UNVERIFIED",
  MISSING: "MISSING",
  UNKNOWN: "UNKNOWN",
});

export const EXPECTED_INBOUND_WEBHOOK = "https://ops.leadcommand.ai/api/webhooks/textgrid/inbound";
export const EXPECTED_CAMPAIGN_ID = "CHM4NL2";

const clean = (value) => String(value ?? "").trim();
const lower = (value) => clean(value).toLowerCase();
const obj = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});

function normUrl(value) {
  return lower(value).replace(/\/+$/, "");
}

function localSaysUnlinked(row) {
  const meta = obj(row?.metadata);
  return /not linked|no campaign|unlinked/i.test(clean(meta.hold_reason)) || lower(row?.registration_status) === "unregistered";
}

/**
 * provider  [{ phone_number, friendly_name, sms_url, campaign }] | null (not read)
 * local     textgrid_numbers rows
 * opts      { blocked: Set<E164>, inboundCounts: Map<E164, n>, poolOf: Map<E164, pool_key>, expected_webhook, expected_campaign, now }
 */
export function reconcileInventory(provider, local = [], opts = {}) {
  const expected_webhook = normUrl(opts.expected_webhook || EXPECTED_INBOUND_WEBHOOK);
  const expected_campaign = clean(opts.expected_campaign || EXPECTED_CAMPAIGN_ID);
  const blocked = opts.blocked instanceof Set ? opts.blocked : new Set();
  const inbound = opts.inboundCounts instanceof Map ? opts.inboundCounts : new Map();
  const poolOf = opts.poolOf instanceof Map ? opts.poolOf : new Map();
  const providerRead = Array.isArray(provider);

  const providerBy = new Map();
  for (const p of providerRead ? provider : []) {
    const phone = normalizeE164(p.phone_number);
    if (phone) providerBy.set(phone, p);
  }
  const localBy = new Map();
  const duplicates = new Set();
  for (const row of local || []) {
    const phone = normalizeE164(row.phone_number);
    if (!phone) continue;
    if (localBy.has(phone)) duplicates.add(phone);
    else localBy.set(phone, row);
  }

  const phones = [...new Set([...providerBy.keys(), ...localBy.keys()])].sort();
  const rows = phones.map((phone) => {
    const p = providerBy.get(phone) || null;
    const l = localBy.get(phone) || null;
    const meta = obj(l?.metadata);
    const flags = [];
    const mismatches = [];

    const inboundSeen = (inbound.get(phone) || 0) > 0 || Boolean(clean(meta.inbound_verified_at));
    let webhook_state = WEBHOOK_STATES.UNKNOWN;
    if (p) {
      const url = normUrl(p.sms_url);
      if (!url || url !== expected_webhook) webhook_state = WEBHOOK_STATES.MISSING;
      else webhook_state = inboundSeen ? WEBHOOK_STATES.VERIFIED : WEBHOOK_STATES.CONFIGURED_UNVERIFIED;
    } else if (inboundSeen) {
      webhook_state = WEBHOOK_STATES.VERIFIED;
    }
    if (webhook_state === WEBHOOK_STATES.MISSING) flags.push("webhook_missing");
    if (webhook_state === WEBHOOK_STATES.CONFIGURED_UNVERIFIED) flags.push("inbound_unverified");

    const campaign = clean(p?.campaign) || null;
    if (p && campaign !== expected_campaign) flags.push("registration_incomplete");
    if (l && lower(l.status) === "paused") flags.push("paused_locally");
    if (blocked.has(phone)) flags.push("operator_blocked");
    if (duplicates.has(phone)) flags.push("duplicate_local");
    if (l && !clean(l.registration_status)) flags.push("registration_unrecorded_locally");
    if (p && l && clean(p.friendly_name) && clean(l.friendly_name) && lower(p.friendly_name) !== lower(l.friendly_name)) flags.push("friendly_name_differs");

    if (p && l) {
      if (campaign === expected_campaign && localSaysUnlinked(l)) mismatches.push("provider_reports_campaign_local_says_unlinked");
      if (campaign !== expected_campaign && lower(l.registration_status) === "registered") mismatches.push("local_registered_provider_has_no_campaign");
      if (campaign !== expected_campaign && lower(l.status) === "active") mismatches.push("active_locally_without_provider_campaign");
      if (webhook_state === WEBHOOK_STATES.MISSING && lower(l.status) === "active") mismatches.push("active_locally_without_inbound_webhook");
      if (duplicates.has(phone)) mismatches.push("duplicate_local_records");
    }

    let state;
    if (p && !l) state = INVENTORY_STATES.PROVIDER_ONLY;
    else if (!p && l) state = providerRead ? INVENTORY_STATES.LOCAL_ONLY : INVENTORY_STATES.MATCHED;
    else state = mismatches.length ? INVENTORY_STATES.CONFIG_MISMATCH : INVENTORY_STATES.MATCHED;

    return {
      phone,
      phone_masked: maskPhone(phone),
      state,
      provider_checked: providerRead,
      flags,
      mismatches,
      webhook_state,
      lifecycle: l ? deriveLifecycleState(l, { blocked, now: opts.now }) : "discovered",
      pool: poolOf.get(phone) || null,
      provider: p ? { friendly_name: clean(p.friendly_name) || null, campaign, sms_webhook: clean(p.sms_url) || null } : null,
      local: l
        ? {
            id: l.id,
            friendly_name: clean(l.friendly_name) || null,
            market: clean(l.market) || null,
            status: clean(l.status) || null,
            health_state: clean(l.health_state) || null,
            registration_status: clean(l.registration_status) || null,
            daily_limit: l.daily_limit ?? null,
            sent_today: l.messages_sent_today ?? null,
            last_used_at: l.last_used_at || null,
            inbound_messages: inbound.get(phone) || 0,
          }
        : null,
    };
  });

  const count = (s) => rows.filter((r) => r.state === s).length;
  return {
    provider_checked: providerRead,
    totals: {
      provider: providerBy.size,
      local: localBy.size,
      matched: count(INVENTORY_STATES.MATCHED),
      provider_only: count(INVENTORY_STATES.PROVIDER_ONLY),
      local_only: count(INVENTORY_STATES.LOCAL_ONLY),
      config_mismatch: count(INVENTORY_STATES.CONFIG_MISMATCH),
      webhook_missing: rows.filter((r) => r.flags.includes("webhook_missing")).length,
      registration_incomplete: rows.filter((r) => r.flags.includes("registration_incomplete")).length,
      duplicates: duplicates.size,
    },
    rows,
  };
}

/** Disagreements between two provider snapshots (e.g. live API vs the owner's pasted console). */
export function compareProviderSnapshots(a = [], b = [], { labels = ["a", "b"] } = {}) {
  const by = (list) => new Map((list || []).map((p) => [normalizeE164(p.phone_number), p]));
  const A = by(a);
  const B = by(b);
  const out = [];
  for (const phone of [...new Set([...A.keys(), ...B.keys()])].sort()) {
    const x = A.get(phone);
    const y = B.get(phone);
    if (!x || !y) {
      out.push({ phone, field: "presence", [labels[0]]: Boolean(x), [labels[1]]: Boolean(y) });
      continue;
    }
    const xw = Boolean(normUrl(x.sms_url));
    const yw = Boolean(normUrl(y.sms_url));
    if (xw !== yw) out.push({ phone, field: "sms_webhook", [labels[0]]: xw, [labels[1]]: yw });
    if (clean(x.campaign) !== clean(y.campaign)) out.push({ phone, field: "campaign", [labels[0]]: clean(x.campaign) || null, [labels[1]]: clean(y.campaign) || null });
  }
  return out;
}

/**
 * The evidence-backed local backfill the PROPOSED seed applies (owner-approved),
 * computed from a reconciliation. Only facts with evidence are written:
 *   registration_status 'registered'   provider reports the expected campaign AND
 *                                      nothing local disputes it (a CONFIG_MISMATCH
 *                                      stays unrecorded until the owner resolves it)
 *   sms_webhook_status 'verified'      inbound SMS has actually reached LeadCommand
 *                                      on that number (webhook_state VERIFIED)
 *   sms_webhook_status 'configured'    provider points at our inbound URL, no inbound yet
 * PROVIDER_ONLY / LOCAL_ONLY numbers are never backfilled here (onboarding /
 * retirement have their own scripts).
 */
export function proposedEvidenceBackfill(report, { expected_campaign = EXPECTED_CAMPAIGN_ID } = {}) {
  const out = [];
  for (const r of report?.rows || []) {
    if (!r.local || !r.provider) continue;
    const patch = { phone: r.phone, registration_status: null, sms_webhook_status: null };
    if (r.provider.campaign === expected_campaign && r.state !== INVENTORY_STATES.CONFIG_MISMATCH) patch.registration_status = "registered";
    if (r.webhook_state === WEBHOOK_STATES.VERIFIED) patch.sms_webhook_status = "verified";
    else if (r.webhook_state === WEBHOOK_STATES.CONFIGURED_UNVERIFIED) patch.sms_webhook_status = "configured";
    if (patch.registration_status || patch.sms_webhook_status) out.push(patch);
  }
  return out;
}

/** Apply a backfill to fleet rows in memory (dry runs). */
export function applyBackfillToFleet(fleet = [], backfill = []) {
  const by = new Map(backfill.map((b) => [b.phone, b]));
  return fleet.map((row) => {
    const b = by.get(normalizeE164(row.phone_number));
    if (!b) return row;
    return {
      ...row,
      registration_status: b.registration_status || row.registration_status || null,
      metadata: { ...(row.metadata || {}), ...(b.sms_webhook_status ? { sms_webhook_status: b.sms_webhook_status } : {}) },
    };
  });
}
