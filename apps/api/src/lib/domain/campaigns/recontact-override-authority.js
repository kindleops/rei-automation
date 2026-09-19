/**
 * WHO MAY RE-CONTACT SOMEONE WHO HAS ALREADY BEEN MESSAGED (§6-§8).
 *
 * `suppress_previously_contacted` defaults to TRUE and gates exactly one rule:
 * the skip for candidates with prior outreach. It does not touch DNC, the
 * suppression list, opt-outs, wrong-number, active-queue dedupe, contact
 * windows, sender eligibility or routing — each of those is its own check and
 * each still runs when this is disabled. That narrowness is why the flag can
 * exist at all.
 *
 * It is a PRE-EXISTING production operator control and this module does not
 * change that. What it adds is the one thing the internal-canary work makes
 * necessary: a canary campaign that disables prior-contact suppression must
 * prove the same internal authorization the canary AUDIENCE required, and every
 * destination it would re-contact must still be in the approved registry.
 *
 * The hazard being closed is specific. Internal canaries are deliberately
 * messaged over and over — that is what makes them usable for proofs, and it is
 * also what makes "disable prior-contact suppression" sound harmless on a
 * canary campaign. If that combination were reachable without internal
 * authorization, the canary source would become a way to describe a campaign as
 * a proof and have a safety rule lifted. It is not: the audience gate and the
 * recontact gate demand the same credential, so neither can be used to reach
 * past the other.
 */
import { isInternalTestPhone } from "@/lib/config/internal-phones.js";
import { INTERNAL_CANARY_SOURCE } from "@/lib/domain/campaigns/canary-audience-source.js";

const clean = (value) => String(value ?? "").trim();

/**
 * @returns {{ ok: boolean, reason: string|null, scope: string }}
 *   `scope` names which policy answered, so the decision is legible in logs.
 */
export function evaluateRecontactOverride({
  suppress_previously_contacted = true,
  candidate_source = null,
  internal_authorized = false,
  destinations = [],
} = {}) {
  // Suppression left ON is the default and needs no authority at all.
  if (suppress_previously_contacted !== false) {
    return { ok: true, reason: null, scope: "suppression_active" };
  }

  const source = clean(candidate_source).toLowerCase();

  if (source === INTERNAL_CANARY_SOURCE) {
    if (internal_authorized !== true) {
      return { ok: false, reason: "canary_recontact_requires_internal_authorization", scope: "internal_canary" };
    }
    // Even authorized, it may only re-contact APPROVED destinations. A canary
    // campaign that somehow carried an outside number cannot use this door.
    const stranger = (Array.isArray(destinations) ? destinations : [])
      .map(clean)
      .filter(Boolean)
      .find((phone) => !isInternalTestPhone(phone));
    if (stranger) {
      return { ok: false, reason: "canary_recontact_destination_not_in_registry", scope: "internal_canary" };
    }
    return { ok: true, reason: null, scope: "internal_canary" };
  }

  /**
   * PRODUCTION IS UNCHANGED, DELIBERATELY.
   *
   * This is a long-standing operator control on production campaigns and
   * narrowing it here would be an unrequested policy change made in passing,
   * during a proof, with no operator asking for it. The canary work must not
   * broaden production eligibility — and it equally must not silently restrict
   * it. Stated explicitly so the asymmetry is a decision rather than an
   * oversight.
   */
  return { ok: true, reason: null, scope: "production_operator_control" };
}
