/**
 * PAUSING A CAMPAIGN MUST STOP IT SENDING.
 *
 * THE DEFECT THIS CLOSES, observed live during canary certification: a campaign
 * was PAUSED, its one already-materialized row was dispatched, and the message
 * went out — provider accepted, SID `SMOYUkH9NB47FNojpVoAUKGuA==`, delivered.
 *
 * The cause was a layering gap, not a bug in pause itself. Pause is a CAMPAIGN
 * lifecycle state; dispatch authority is evaluated per QUEUE ROW, and nothing
 * in that path read `campaigns.status`. `queue_atomic_claim_send_row` mentions
 * pause only in its comments and never joins the campaigns table. So pause
 * stopped future MATERIALIZATION while work already materialized kept its own
 * momentum — and the operator control plainly implies it stops sending.
 *
 * WHAT PAUSE IS, AND IS NOT. It is reversible operational control, so this
 * DEFERS rather than cancels: the row keeps its id, body, schedule and retry
 * budget, and Resume releases the same row with no re-materialization. It is
 * not a provider failure, not a suppression verdict, and not a cancellation —
 * reporting it as any of those would tell an operator something untrue about
 * why their message is sitting still.
 *
 * WHAT IT DOES NOT TOUCH. Pause is ONE additional authority check. Suppression,
 * DNC, wrong-number, sender health, contact window, emergency stop, queue
 * posture, scoped-canary authorization and idempotency all still run exactly as
 * before, and all still run after Resume.
 */
import { supabase as defaultSupabase } from "@/lib/supabase/client.js";

/** The operator-readable reason a held row carries. */
export const CAMPAIGN_PAUSED_REASON = "campaign_paused";

/** Read when the campaign's own state cannot be established. */
export const CAMPAIGN_STATE_UNREADABLE_REASON = "campaign_state_unreadable";

/**
 * Statuses that block dispatch of already-materialized work.
 *
 * Deliberately just `paused`. Other lifecycle states have their own semantics
 * that this pass has not traced — `archived` in particular is applied to
 * completed campaigns whose history must stay readable, and blocking on it here
 * would change lifecycle policy as a side effect of a pause fix. Widening this
 * set is a decision, not a tidy-up.
 */
const BLOCKING_CAMPAIGN_STATUSES = new Set(["paused"]);

const clean = (value) => String(value ?? "").trim();

/**
 * May this queue row dispatch, given its campaign's current state?
 *
 * @returns {{ok: boolean, reason: string|null, scope: string, campaign_status?: string|null}}
 *   `scope` names which rule answered, so the decision is legible in logs and
 *   a "pass" can be told apart from "this rule did not apply".
 */
export async function evaluateCampaignDispatchAuthority(queue_row = {}, deps = {}) {
  const campaign_id = clean(queue_row.campaign_id);

  /**
   * Most queue traffic is not campaign-driven — manual Inbox replies, seller
   * automation, buyer disposition, internal proof tooling. A missing campaign
   * id is the normal case for those and must never be an error.
   */
  if (!campaign_id) {
    return { ok: true, reason: null, scope: "non_campaign_traffic" };
  }

  const supabase = deps.supabase || deps.supabaseClient || defaultSupabase;

  let status = null;
  try {
    if (typeof deps.loadCampaignStatus === "function") {
      status = await deps.loadCampaignStatus(campaign_id);
    } else {
      const { data, error } = await supabase
        .from("campaigns")
        .select("status")
        .eq("id", campaign_id)
        .maybeSingle();
      if (error) throw error;
      // A campaign id that resolves to nothing is not a readable "active".
      if (!data) {
        return {
          ok: false,
          reason: CAMPAIGN_STATE_UNREADABLE_REASON,
          scope: "campaign_not_found",
          campaign_status: null,
        };
      }
      status = data.status;
    }
  } catch (error) {
    /**
     * FAIL CLOSED, BUT DEFER — not fail.
     *
     * An unreadable control plane is not permission to send. It is equally not
     * evidence that the message is bad, so the row must not be burned: no
     * retry consumed, no provider failure recorded. The next run re-reads and
     * proceeds normally if the campaign is live.
     */
    return {
      ok: false,
      reason: CAMPAIGN_STATE_UNREADABLE_REASON,
      scope: "campaign_state_read_failed",
      campaign_status: null,
      detail: error?.message || null,
    };
  }

  const normalized = clean(status).toLowerCase();
  if (BLOCKING_CAMPAIGN_STATUSES.has(normalized)) {
    return {
      ok: false,
      reason: CAMPAIGN_PAUSED_REASON,
      scope: "campaign_lifecycle",
      campaign_status: normalized,
    };
  }

  return { ok: true, reason: null, scope: "campaign_lifecycle", campaign_status: normalized || null };
}

export default evaluateCampaignDispatchAuthority;
