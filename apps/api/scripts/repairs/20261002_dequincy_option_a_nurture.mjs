#!/usr/bin/env node

/**
 * RC 7.1 — 2157 N Dequincy, owner-approved OPTION A: nurture, not lost.
 *
 * Deal f0615bc0-4ae5-4b9d-8bfe-8ade7a0e1634 (property 251049126, owner
 * mo_8a4ba81354944404ebaa47a6, thread +13176279734) is a REAL seller:
 * "Not selling that one until our old guy tenant is done with it." (2026-04-29).
 * An operator write on 2026-09-08 flipped dead -> active while the stage was
 * already `closed`, before the closed-won trigger existed, leaving
 * stage=closed + status=active. Owner rule: "A not interested is a 30 day
 * follow up" — so the deal becomes a nurture deal, never closed/lost/suppressed.
 *
 * Split out of tmp/rc/d2-canary-cleanup.sql §1c (that file is archive-and-flag
 * only for internal canaries; this is a real seller and gets its own audited
 * step, run with the not-interested nurture repair).
 *
 * Canonical nurture semantics — the same as repair-not-interested-nurture.mjs:
 *   1. stage closed -> offer_interest and status active -> nurture, plus ONE
 *      audit row, in ONE statement/transaction (applyStatusTransitionAtomic).
 *      The stage must leave `closed`: enforce_closed_won_authority refuses a
 *      `closed` row whose status changes to a non-lost status.
 *   2. ONE 30-day nurture follow-up through the canonical scheduleFollowUp
 *      (deferred template resolution, every enqueue and send-time guard
 *      applies; cycle id rc71_dequincy_option_a so a re-run is idempotent and
 *      a live nurture row means duplicate_followup_exists, never a second row).
 * next_action is left as the operator set it (future_seller_followup_tenant_timing).
 *
 * Guards (any failure -> nothing is written):
 *   - the row still has stage=closed AND status=active (else: already applied
 *     or changed since the audit -> skipped, never clobbered);
 *   - no opt-out / DNC / suppression / invalid-number evidence on the thread
 *     (same evidence test as the nurture repair: hydrate + classifier);
 *   - no live nurture follow-up already exists (then only step 1 runs).
 *
 * DRY RUN BY DEFAULT. Usage (from apps/api, RC_SHA checkout, after deploy):
 *   node --no-warnings --import ./scripts/register-aliases-ops.mjs scripts/repairs/20261002_dequincy_option_a_nurture.mjs
 *   node --no-warnings --import ./scripts/register-aliases-ops.mjs scripts/repairs/20261002_dequincy_option_a_nurture.mjs --apply
 * --apply needs SUPABASE_DB_URL / DATABASE_URL (atomic write) and the service key.
 */

import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

import {
  applyStatusTransitionAtomic,
  classifyNurtureRepair,
  e164,
  hydrate,
  openRepairPgClient,
} from "../repair-not-interested-nurture.mjs";

dotenv.config({ path: ".env.local", quiet: true });

export const DEQUINCY = Object.freeze({
  opportunity_id: "f0615bc0-4ae5-4b9d-8bfe-8ade7a0e1634",
  property_id: "251049126",
  thread_key: "+13176279734",
});
export const SOURCE = "rc71_dequincy_option_a";
const APPLY = process.argv.includes("--apply");

/** Pure decision: what to do with the row as it stands now. */
export function planDequincy({ opportunity, seller }) {
  if (!opportunity) return { action: "SKIP", reason: "opportunity_missing" };
  if (opportunity.acquisition_stage !== "closed" || opportunity.opportunity_status !== "active") {
    const done = opportunity.opportunity_status === "nurture";
    return {
      action: done ? "ALREADY_APPLIED" : "SKIP",
      reason: done ? "status_already_nurture" : `state_changed_since_audit:${opportunity.acquisition_stage}/${opportunity.opportunity_status}`,
      needFollowUp: done && seller.live_nurture_rows === 0,
    };
  }
  // Reuse the nurture repair's opt-out evidence test. The deal's latest_intent
  // is NULL (operator-written row), so classify as a not-interested seller.
  const verdict = classifyNurtureRepair({
    ...seller,
    opportunity: { ...opportunity, latest_intent: "not_interested", opportunity_status: "suppressed" },
    inbound_after_not_interested: 0,
  });
  if (verdict.action === "BLOCKED_OPT_OUT") return { action: "BLOCKED_OPT_OUT", reason: "opt_out_or_suppression_evidence" };
  return { action: "APPLY", reason: "owner_option_a_nurture_not_lost", needFollowUp: seller.live_nurture_rows === 0 };
}

async function main() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing");
  const db = createClient(url, key, { auth: { persistSession: false } });

  const { data: opportunity, error } = await db
    .from("acquisition_opportunities")
    .select("id,primary_thread_key,primary_property_id,master_owner_id,acquisition_stage,opportunity_status,next_action,latest_intent,version")
    .eq("id", DEQUINCY.opportunity_id)
    .maybeSingle();
  if (error) throw error;
  const seller = await hydrate(db, {
    phone: e164(opportunity?.primary_thread_key || DEQUINCY.thread_key),
    opportunity,
    not_interested_at: "2026-04-29T00:00:00Z",
    killed_rows: [],
  });
  const plan = planDequincy({ opportunity, seller });
  const report = {
    mode: APPLY ? "apply" : "dry_run",
    opportunity: opportunity && {
      id: opportunity.id,
      stage: opportunity.acquisition_stage,
      status: opportunity.opportunity_status,
      next_action: opportunity.next_action,
      version: opportunity.version,
    },
    thread: seller.phone,
    opt_out_evidence: {
      thread_suppressed: seller.thread?.is_suppressed === true,
      contactability: seller.thread?.contactability_status || null,
      active_suppressions: seller.active_suppressions,
      opt_out_events: seller.opt_out_events,
    },
    inbound_since_2026_04_29: seller.inbound_after_not_interested,
    live_nurture_rows: seller.live_nurture_rows,
    plan,
  };

  if (APPLY && (plan.action === "APPLY" || (plan.action === "ALREADY_APPLIED" && plan.needFollowUp))) {
    if (plan.action === "APPLY") {
      const pgClient = await openRepairPgClient();
      try {
        report.status = await applyStatusTransitionAtomic(pgClient, {
          opportunity_id: DEQUINCY.opportunity_id,
          from_status: "active",
          from_stage: "closed",
          to_status: "nurture",
          to_stage: "offer_interest",
          source: SOURCE,
          reason: "owner_option_a_not_interested_is_nurture_not_lost",
          idempotency_key: `${SOURCE}:${DEQUINCY.opportunity_id}`,
          metadata: {
            rc71_correction: "closed_stage_with_active_status_to_nurture",
            owner_decision: "Dequincy Option A (nurture, not lost)",
            previous_stage: "closed",
            previous_status: "active",
          },
        });
      } finally {
        await pgClient.end().catch(() => {});
      }
    }
    if (plan.needFollowUp) {
      const { scheduleFollowUp } = await import("../../src/lib/domain/seller-flow/seller-followup-scheduler.js");
      report.follow_up = await scheduleFollowUp(
        "not_interested",
        seller.phone,
        {
          source: SOURCE,
          inbound_message_event_id: SOURCE, // cycle id: re-runs stay idempotent
          master_owner_id: opportunity?.master_owner_id || null,
          property_id: opportunity?.primary_property_id || DEQUINCY.property_id,
        },
        db,
      );
    }
  }
  console.log(JSON.stringify(report, null, 2));
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (invokedDirectly) {
  main().catch((error) => {
    console.error("[dequincy-option-a] failed:", error?.message || error);
    process.exitCode = 1;
  });
}
