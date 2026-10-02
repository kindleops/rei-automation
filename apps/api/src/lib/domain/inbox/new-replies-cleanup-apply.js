/**
 * NEW REPLIES CLEANUP 7.2 — the repair executor (AFTER OWNER APPROVAL ONLY).
 *
 * Executes one preview row's `apply` list through the canonical authorities:
 *   presentation  applyClassifierCorrection   (CAS, old values preserved)
 *   lead state    patchUniversalLeadState     (audited universal lead state)
 *   relationship  recordContactOutcome        (contact x property, V2-1B)
 *                 applyInboundSuppression     (owner-scoped wrong number)
 *   opportunity   transitionOpportunityStage  (closed / lost)
 *   follow-ups    cancelPendingFollowUpsForThread, scheduleFollowUp
 *   compliance    applyInboundSuppression     (opt-out only)
 *
 * What it NEVER does: send or queue a message to a new contact, send a
 * clarification, change a lifecycle stage, write the global DNC list for a
 * wrong person, or write raw SQL. A next contact is RECORDED as a plan on the
 * thread; contacting them is a separate, approved campaign action. Email is
 * recorded as pending-email (sending is off).
 *
 * Idempotent: the presentation write is compare-and-set and refuses a second
 * run (metadata[source].applied_at); every other authority carries its own
 * dedupe (follow-up dedupe keys, opportunity idempotency keys, upserts).
 */

import { CLEANUP_SOURCE, CLEANUP_CATEGORY } from "./new-replies-cleanup.js";

const clean = (v) => String(v ?? "").trim();

const BUCKET_BY_CATEGORY = Object.freeze({
  [CLEANUP_CATEGORY.WRONG_PERSON]: "dead",
  [CLEANUP_CATEGORY.SOLD]: "dead",
  [CLEANUP_CATEGORY.HOSTILE]: "dead",
  [CLEANUP_CATEGORY.NOT_INTERESTED]: "follow_up",
  [CLEANUP_CATEGORY.NOT_FOR_SALE]: "follow_up",
  [CLEANUP_CATEGORY.AUTO_REPLY]: "cold",
  [CLEANUP_CATEGORY.NOISE]: "cold",
  [CLEANUP_CATEGORY.TEXT_ACK]: "cold",
  [CLEANUP_CATEGORY.EMOJI_ACK]: "cold",
  [CLEANUP_CATEGORY.OPT_OUT]: "suppressed",
});

function addDaysIso(now, days) {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

/**
 * @param {object} plan     one row from planNewRepliesCleanup
 * @param {object} ctx      { thread (full row), opportunity, next_contact_plan (unmasked, optional) }
 * @param {object} deps     canonical authorities (all injected; tests pass doubles)
 */
export async function applyNewRepliesCleanupPlan(plan, ctx = {}, deps = {}) {
  const now = deps.now || new Date().toISOString();
  const thread = ctx.thread || {};
  const threadKey = clean(thread.thread_key);
  const steps = [];
  const record = (step, result) => {
    steps.push({ step, ok: result?.ok !== false, reason: result?.reason || null, skipped: result?.skipped === true });
    return result;
  };
  const meta = (reason) => ({
    change_source: "system",
    source_view: CLEANUP_SOURCE,
    reason,
    updated_by: CLEANUP_SOURCE,
    classifier_version: plan?.provenance?.classifier_version || null,
    metadata: { source: CLEANUP_SOURCE, category: plan?.category || null },
  });

  if (!threadKey) return { ok: false, reason: "missing_thread_key", steps };

  for (const action of plan?.apply || []) {
    switch (action) {
      case "write_reclassification": {
        const bucket = BUCKET_BY_CATEGORY[plan.category];
        const res = await deps.applyClassifierCorrection(deps.supabase, {
          thread,
          source: CLEANUP_SOURCE,
          now,
          correction: {
            last_intent: plan.correct_classification,
            ...(bucket ? { inbox_bucket: bucket } : {}),
            classifier_version: plan?.provenance?.classifier_version || null,
            category: plan.category,
            reason: plan.why,
            extra: plan.language ? { language_preference: plan.language } : undefined,
          },
        });
        record(action, res);
        // A conflict or a second run stops here: nothing else may act on a
        // thread whose state moved since the preview.
        if (res?.ok === false || res?.skipped) {
          return { ok: res?.ok !== false, reason: res?.reason || null, steps };
        }
        break;
      }
      case "mark_relationship_not_owner": {
        record(action, await deps.recordContactOutcome(deps.supabase, {
          property_id: clean(thread.property_id),
          contact_phone_e164: threadKey,
          outcome: "not_owner",
          master_owner_id: thread.master_owner_id || null,
          prospect_id: thread.prospect_id || null,
          rejection_reason: "wrong_person_reply",
          suppression_scope: "contact_property_pair",
          source_thread_key: threadKey,
          now,
        }));
        // Owner-scoped phone flag only when the owner is known. NEVER the
        // global sms_suppression_list: a wrong person did not opt out.
        if (clean(thread.master_owner_id)) {
          record("mark_owner_phone_wrong_number", await deps.applyInboundSuppression({
            supabaseClient: deps.supabase,
            phoneNumber: threadKey,
            ownerId: thread.master_owner_id,
            reason: "wrong_number",
            threadKey,
            dryRun: false,
          }));
        }
        break;
      }
      case "archive_thread": {
        const disposition =
          plan.category === CLEANUP_CATEGORY.SOLD ? "sold"
          : plan.category === CLEANUP_CATEGORY.HOSTILE ? "unqualified"
          : "wrong_person";
        record(action, await deps.patchUniversalLeadState({
          threadKey,
          supabase: deps.supabase,
          patch: {
            disposition,
            operational_status: "paused",
            // A resolved conversation owes nobody a review: this also clears the
            // gap-recovery sweep's placeholder human_review (P7), which its own
            // cleanup never clears on a thread whose last message is inbound.
            next_action: null,
            is_archived: true,
            archived_at: now,
            archive_scope: "conversation",
            archive_reason: plan.proposed_state?.archive_reason || disposition,
          },
          meta: meta(plan.why),
        }));
        break;
      }
      case "close_opportunity_lost": {
        const opp = ctx.opportunity;
        if (!opp?.id) {
          record(action, { ok: true, skipped: true, reason: "no_opportunity_row" });
          break;
        }
        if (clean(opp.acquisition_stage) === "closed") {
          record(action, { ok: true, skipped: true, reason: "already_closed" });
          break;
        }
        record(action, await deps.transitionOpportunityStage(opp.id, {
          to_stage: "closed",
          outcome: "lost",
          reason: "property_sold_per_seller_reply",
          source: CLEANUP_SOURCE,
          actor: CLEANUP_SOURCE,
          idempotency_key: `${CLEANUP_SOURCE}:close_lost:${opp.id}`,
        }, { supabase: deps.supabase }));
        break;
      }
      case "cancel_pending_followups":
        record(action, await deps.cancelPendingFollowUpsForThread({
          thread_key: threadKey,
          reason: `${CLEANUP_SOURCE}:${plan.category}`,
          now,
          supabase: deps.supabase,
        }));
        break;
      case "set_not_interested_nurture":
        record(action, await deps.patchUniversalLeadState({
          threadKey,
          supabase: deps.supabase,
          patch: {
            disposition: "not_interested",
            operational_status: "follow_up_due",
            next_action: "schedule_follow_up",
            next_action_at: addDaysIso(now, 30),
            follow_up_at: addDaysIso(now, 30),
          },
          meta: meta(plan.why),
        }));
        break;
      case "schedule_nurture_followup":
        // The canonical nurture scheduler: deferred row, template resolved at
        // send time, every send-time guard still applies, dedupe-keyed.
        record(action, await deps.scheduleFollowUp("not_interested", threadKey, {}, deps.supabase));
        break;
      case "clear_stale_decline":
        record(action, await deps.patchUniversalLeadState({
          threadKey,
          supabase: deps.supabase,
          patch: { disposition: "none" },
          meta: meta("latest reply is engagement; the stored not_interested is stale"),
        }));
        break;
      case "record_language_preference":
        // Recorded with the correction above (metadata[source].language_preference);
        // no resend is queued by the repair.
        record(action, { ok: true, skipped: true, reason: "recorded_with_reclassification" });
        break;
      case "record_next_contact_plan": {
        const next = ctx.next_contact_plan || null;
        record(action, {
          ok: true,
          skipped: true,
          reason: next
            ? next.channel === "email"
              ? "pending_email_recorded_email_sending_off"
              : `next_contact_${next.channel}_recorded_not_contacted`
            : "no_further_contact",
        });
        break;
      }
      case "suppress_opt_out":
        record(action, await deps.applyInboundSuppression({
          supabaseClient: deps.supabase,
          phoneNumber: threadKey,
          reason: "opt_out",
          threadKey,
          dryRun: false,
        }));
        break;
      default:
        record(action, { ok: false, reason: "unknown_action" });
    }
  }
  return { ok: steps.every((s) => s.ok), steps };
}

export default applyNewRepliesCleanupPlan;
