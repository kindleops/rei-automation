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
 * Replies (owner decision 2026-10-02): `queue_late_reply` queues ONE reply to
 * the seller on this thread through the normal queue (see queueCleanupReply:
 * active template, sender engine, contact window, vendor-DNC hold).
 *
 * What it NEVER does: send or queue a message to a new contact, pin a sending
 * number, change a lifecycle stage, write the global DNC list for a
 * wrong person, or write raw SQL. A next contact is RECORDED as a plan on the
 * thread; contacting them is a separate, approved campaign action. Email is
 * recorded as pending-email (sending is off).
 *
 * Idempotent: the presentation write is compare-and-set and refuses a second
 * run (metadata[source].applied_at); every other authority carries its own
 * dedupe (follow-up dedupe keys, opportunity idempotency keys, upserts).
 */

import { CLEANUP_SOURCE, CLEANUP_CATEGORY } from "./new-replies-cleanup.js";
import { buildCleanupReplyRow, checkCleanupRowAgainstRunner } from "./cleanup-reply-row.js";
import { normalizeVendorDnc } from "./vendor-dnc-lookup.js";

const clean = (v) => String(v ?? "").trim();

// ─── Cleanup replies (owner decision 2026-10-02) ────────────────────────────
//
// A cleanup reply goes through the NORMAL queue / send path only:
//   template   an ACTIVE sms_templates row, stamped by template_id
//   sender     the normal sender-selection engine (chooseTextgridNumber:
//              routing, health, cooling, caps). NEVER a pinned number: a
//              from-number on the plan is ignored, and there is no override.
//   window     the recipient's contact window (08:00-21:00 local)
//   vendor DNC seller.owner_phone.do_not_call -> HOLD (semantics unconfirmed)
//   our flags  suppression / DNC / opt-out, and a wrong person for THIS
//              property -> HOLD (every lookup fails closed)
//   identity   the seller first name from the canonical resolver (the runner
//              requires it on every non-operator row)
//   runner     the built row passes the runner's OWN preclaim check, contact
//              window, blank-greeting and template-asset guards, or it HOLDS
// Chain order: vendor DNC -> suppression -> relationship -> identity ->
// template -> sender -> window -> runner invariants. deps.dryRun runs the
// same chain with ZERO writes.
// Anything that fails is HELD with a reason and reported, never forced.

export const REPLY_HOLD = Object.freeze({
  VENDOR_DNC: "vendor_dnc_semantics_unconfirmed",
  VENDOR_DNC_UNKNOWN: "vendor_dnc_lookup_unavailable",
  SUPPRESSED: "suppressed_or_opted_out",
  SUPPRESSION_UNKNOWN: "suppression_lookup_unavailable",
  NOT_OWNER: "wrong_person_relationship",
  RELATIONSHIP_UNKNOWN: "relationship_lookup_unavailable",
  NO_TEMPLATE: "template_missing_or_inactive",
  RENDER: "template_render_incomplete",
  WINDOW: "outside_contact_window",
  TIMEZONE: "recipient_timezone_unresolved",
  NO_SENDER: "no_eligible_sender",
  IDENTITY_UNKNOWN: "seller_identity_lookup_unavailable",
  NO_SELLER_NAME: "seller_first_name_unresolved",
  RUNNER_INVALID: "runner_invariant_failed",
  ASSET: "template_asset_incompatible",
  REVIEW: "needs_review",
});

/**
 * THE COHORT GATE (deploy runbook): the cleanup acts ONLY on the frozen
 * 2026-10-01 New Replies cohort (111 threads) and the 27 unanswered
 * active-deal sellers. A thread / deal outside it is refused, and a run with
 * no cohort at all is refused (fail closed).
 *   cohort = { thread_ids: Set, thread_keys: Set, deal_ids: Set }
 */
export function isInCleanupCohort(cohort, { thread_id = null, thread_key = null, deal_id = null } = {}) {
  if (!cohort) return false;
  const has = (set, v) => Boolean(v) && set instanceof Set && set.has(String(v));
  return has(cohort.thread_ids, thread_id) || has(cohort.thread_keys, thread_key) || has(cohort.deal_ids, deal_id);
}

/**
 * TODO(vendor-dnc-semantics): once the source of seller.owner_phone.do_not_call
 * is confirmed (federal DNC registry scrub? voice-only? carrier data?), encode
 * the per-channel rule here: e.g. { sms: "allow_reply_to_inbound", voice:
 * "block" }. Until then the flag is NEITHER SMS suppression NOR ignored: every
 * channel holds, with a reason an operator can see.
 */
export function vendorDncChannelRule({ channel = "sms", vendor_dnc = false } = {}) {
  if (!vendor_dnc) return { action: "allow", reason: null };
  void channel;
  return { action: "hold", reason: REPLY_HOLD.VENDOR_DNC };
}

const TOKEN_RE = /\{\{\s*([a-z_]+)\s*\}\}/gi;

// Tokens that render the SELLER's name into the copy.
export const FIRST_NAME_TOKENS = Object.freeze(["seller_first_name", "first_name", "owner_first_name", "seller_name"]);

export function templateUsesFirstName(body) {
  return [...clean(body).matchAll(TOKEN_RE)].some((m) => FIRST_NAME_TOKENS.includes(m[1].toLowerCase()));
}

export function renderCleanupTemplate(body, variables = {}) {
  const text = clean(body).replace(TOKEN_RE, (m, key) => {
    const v = clean(variables[key]);
    return v || m;
  });
  return { text, unresolved: [...text.matchAll(TOKEN_RE)].map((m) => m[1]) };
}

/**
 * Queue ONE cleanup reply, or hold it. Idempotent: the dedupe key is per
 * thread, so a second run finds the first row instead of sending twice.
 */
export async function queueCleanupReply(plan, ctx = {}, deps = {}) {
  const thread = ctx.thread || {};
  const threadKey = clean(thread.thread_key);
  const reply = plan?.reply || null;
  const dryRun = deps.dryRun === true;
  const hold = (reason, extra = {}) => ({ ok: true, held: true, held_reason: reason, thread_key: threadKey, ...extra });
  const safely = async (fn, ...args) => {
    try {
      return fn ? await fn(...args) : null;
    } catch {
      return null;
    }
  };
  if (!isInCleanupCohort(deps.cohort, { thread_key: threadKey, deal_id: ctx.deal_id || plan?.deal || null })) {
    return { ok: false, reason: deps.cohort ? "outside_frozen_cohort" : "cohort_gate_missing", thread_key: threadKey };
  }
  if (!reply?.template_id) return hold(REPLY_HOLD.REVIEW, { detail: reply?.review_reason || "no_template_for_this_reply" });

  // 1. Vendor do_not_call (seller.owner_phone). Fail closed: unreadable is not clear.
  const vendor = normalizeVendorDnc(await safely(deps.loadVendorDnc, threadKey));
  if (vendor.dnc === null) return hold(REPLY_HOLD.VENDOR_DNC_UNKNOWN, vendor.basis ? { detail: vendor.basis } : {});
  const rule = vendorDncChannelRule({ channel: "sms", vendor_dnc: vendor.dnc === true });
  if (rule.action === "hold") return hold(rule.reason);

  // 2. Our own suppression / DNC / opt-out (sms_suppression_list, automation
  //    suppressions, thread suppression, opt-out events). Fail closed.
  const suppression = await safely(deps.checkSuppression, threadKey);
  if (!suppression) return hold(REPLY_HOLD.SUPPRESSION_UNKNOWN);
  if (suppression.suppressed) return hold(REPLY_HOLD.SUPPRESSED, { detail: suppression.reason || null });

  // 3. Wrong person for THIS property (relationship-scoped). Fail closed.
  const relationship = await safely(deps.checkRelationship, {
    thread_key: threadKey,
    property_id: clean(thread.property_id) || null,
    master_owner_id: clean(thread.master_owner_id) || null,
  });
  if (!relationship) return hold(REPLY_HOLD.RELATIONSHIP_UNKNOWN);
  if (relationship.not_owner) return hold(REPLY_HOLD.NOT_OWNER, { detail: relationship.reason || null });

  // 3b. Seller identity (canonical resolver): it fills the candidate
  //     snapshot the runner requires. Unreadable -> HOLD (fail closed). An
  //     unresolved first NAME holds only when the template greets by name
  //     (below); copy without a name token does not need one.
  const identity = await safely(deps.loadSellerIdentity, {
    thread_key: threadKey,
    master_owner_id: clean(thread.master_owner_id) || null,
  });
  if (!identity) return hold(REPLY_HOLD.IDENTITY_UNKNOWN);

  // 4. Template: must exist; must be ACTIVE to send. A dry run reports an
  //    inactive row (expected until the deploy window activates it), or a row
  //    only present in the pending deploy SQL, and goes on.
  const template = await safely(deps.loadTemplate, reply.template_id);
  if (!template) return hold(REPLY_HOLD.NO_TEMPLATE, { template_id: reply.template_id, template_state: "missing" });
  const template_state = template.is_active === true
    ? "active"
    : template.pending_deploy_sql === true
      ? "pending_deploy_sql"
      : "inactive_until_deploy";
  if (template_state !== "active" && !dryRun) return hold(REPLY_HOLD.NO_TEMPLATE, { template_id: reply.template_id, template_state });
  if (templateUsesFirstName(template.template_body) && !clean(identity.seller_first_name)) {
    return hold(REPLY_HOLD.NO_SELLER_NAME, { detail: identity.identity_alignment_status || null, template_state });
  }
  const nameVars = clean(identity.seller_first_name) ? { seller_first_name: identity.seller_first_name } : {};
  const rendered = renderCleanupTemplate(template.template_body, { ...nameVars, ...(reply.variables || {}) });
  if (rendered.unresolved.length) return hold(REPLY_HOLD.RENDER, { unresolved: rendered.unresolved, template_state });

  // 5. Sender: the normal engine decides; nothing on the plan can pin a number.
  const sender = await safely(deps.selectSender, { thread, ctx, language: template.language });
  if (!sender || sender.routing_allowed !== true || !clean(sender.phone_number)) {
    return hold(REPLY_HOLD.NO_SENDER, { detail: sender?.routing_block_reason || sender?.selection_reason || "sender_engine_unavailable", template_state });
  }

  // 6. The recipient's contact window.
  const now = deps.now ? new Date(deps.now) : new Date();
  const tz = deps.resolveTimezone ? deps.resolveTimezone(ctx) : null;
  if (!tz) return hold(REPLY_HOLD.TIMEZONE, { template_state });
  // contact-window-timezone.isWithinContactWindow returns { ok, reason, ... };
  // a bare boolean is accepted too. Anything else is "outside" (fail closed).
  const windowCheck = deps.isWithinContactWindow ? deps.isWithinContactWindow(now, tz) : false;
  const inWindow = windowCheck === true || windowCheck?.ok === true;

  const dedupe_key = `${CLEANUP_SOURCE}:reply:${threadKey}`;
  // A re-queue (rc-7.1) writes a NEW queue_key for the same per-thread
  // dedupe_key: queue_key is unique across all statuses, the dedupe key only
  // across live ones, so the thread can never hold two live rows.
  const queue_key = deps.queueKeySuffix ? `${dedupe_key}:${deps.queueKeySuffix}` : dedupe_key;
  const nowIso = now.toISOString();
  const row = buildCleanupReplyRow({
    thread,
    property: ctx.property || {},
    market: ctx.market || null,
    template,
    rendered_text: rendered.text,
    sender,
    timezone: tz,
    identity,
    category: plan.category || null,
    source: CLEANUP_SOURCE,
    dedupe_key,
    queue_key,
    now: nowIso,
    extra_metadata: { ...(reply.plan_template_id ? { plan_template_id: reply.plan_template_id } : {}), ...(deps.extraMetadata || {}) },
  });

  // 7. The runner's own invariants on the exact row (preclaim validity, seller
  //    name, blank-greeting guard, the runner's recipient-zone window).
  const runner = checkCleanupRowAgainstRunner(row, { now: nowIso });
  const runnerWindow = runner.window
    ? { allowed: runner.window.allowed === true, reason: runner.window.reason || null, timezone: runner.window.timezone || null }
    : null;
  const summary = {
    thread_key: threadKey,
    template_id: template.template_id,
    template_state,
    rendered_message: rendered.text,
    sender: { phone_number: sender.phone_number, selection_reason: sender.selection_reason || null },
    recipient_timezone: tz,
    seller_first_name_source: identity.seller_name_source || null,
    queue_key,
    dedupe_key,
    window: typeof windowCheck === "object" && windowCheck ? windowCheck : { ok: inWindow },
    runner_window: runnerWindow,
    checks: { vendor_dnc: false, suppressed: false, not_owner: false },
  };
  // Both windows must pass: the executor's and the runner's.
  // 8. Template x property compatibility, as the runner checks it at send
  //    (a read; evaluated even when step 7 failed so the report is complete).
  let asset = null;
  if (deps.evaluateTemplateAssetGuard) {
    asset = await safely(deps.evaluateTemplateAssetGuard, { supabase: deps.supabase, queue_row: row, body: rendered.text });
    summary.asset_guard = asset ? { allowed: asset.allowed === true, reason: asset.reason || null } : { allowed: false, reason: "asset_guard_unavailable" };
  }
  summary.runner_failures = runner.failures;
  const outsideWindow = !inWindow || runner.failures.includes("outside_local_send_window");
  const otherRunner = runner.failures.filter((f) => f !== "outside_local_send_window");
  const assetOk = !deps.evaluateTemplateAssetGuard || asset?.allowed === true;
  const heldAt = (held_reason, extra = {}) => ({ ok: true, held: true, held_reason, ...(dryRun ? { would_queue: false } : {}), ...extra, ...summary });
  if (outsideWindow) return heldAt(REPLY_HOLD.WINDOW, { passes_all_other_checks: otherRunner.length === 0 && assetOk });
  if (!runner.ok) return heldAt(REPLY_HOLD.RUNNER_INVALID, { detail: runner.reason });
  if (!assetOk) return heldAt(REPLY_HOLD.ASSET, { detail: asset?.reason || "asset_guard_unavailable" });

  if (dryRun) {
    // ZERO writes: the queue writer is never reached in a dry run.
    return { ok: true, would_queue: true, ...summary };
  }

  const result = await deps.enqueueSendQueueItem(row, { supabase: deps.supabase });
  if (result?.ok === false) return { ok: false, reason: result.reason || "enqueue_failed", thread_key: threadKey };
  return {
    ok: true,
    queued: true,
    idempotent_replay: result?.idempotent_replay === true,
    queue_row_id: result?.queue_row_id || result?.item_id || null,
    template_id: template.template_id,
    thread_key: threadKey,
    queue_key,
  };
}

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
    steps.push({
      step,
      ok: result?.ok !== false,
      reason: result?.reason || null,
      skipped: result?.skipped === true,
      ...(result?.held ? { held: true, held_reason: result.held_reason } : {}),
    });
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
  if (!isInCleanupCohort(deps.cohort, { thread_id: thread.id, thread_key: threadKey })) {
    return { ok: false, reason: deps.cohort ? "outside_frozen_cohort" : "cohort_gate_missing", steps };
  }

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
      case "schedule_nurture_followup": {
        // Vendor do_not_call holds a cleanup send of ANY kind (owner decision
        // 2026-10-02); an unreadable flag holds too (fail closed).
        let vendor_dnc = null;
        try {
          vendor_dnc = normalizeVendorDnc(deps.loadVendorDnc ? await deps.loadVendorDnc(threadKey) : null).dnc;
        } catch {
          vendor_dnc = null;
        }
        if (vendor_dnc !== false) {
          record(action, { ok: true, skipped: true, held: true, held_reason: vendor_dnc === true ? REPLY_HOLD.VENDOR_DNC : REPLY_HOLD.VENDOR_DNC_UNKNOWN });
          break;
        }
        // The canonical nurture scheduler: deferred row, template resolved at
        // send time, every send-time guard still applies, dedupe-keyed. The
        // repair tag lands in send_queue.metadata.source for the verifier.
        record(action, await deps.scheduleFollowUp("not_interested", threadKey, {
          source: CLEANUP_SOURCE,
          repair_tag: CLEANUP_SOURCE,
          master_owner_id: thread.master_owner_id || null,
          property_id: thread.property_id || null,
        }, deps.supabase));
        break;
      }
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
        // A next-contact phone carrying the vendor DNC flag is held exactly
        // like a reply (owner decision 2026-10-02), never treated as clear.
        const nextHeld = next?.channel === "phone" && next?.vendor_dnc !== false;
        record(action, {
          ok: true,
          skipped: true,
          ...(nextHeld ? { held: true, held_reason: next?.vendor_dnc === true ? REPLY_HOLD.VENDOR_DNC : REPLY_HOLD.VENDOR_DNC_UNKNOWN } : {}),
          reason: next
            ? next.channel === "email"
              ? "pending_email_recorded_email_sending_off"
              : `next_contact_${next.channel}_recorded_not_contacted`
            : "no_further_contact",
        });
        break;
      }
      case "queue_late_reply":
        record(action, await queueCleanupReply(plan, ctx, deps));
        break;
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
