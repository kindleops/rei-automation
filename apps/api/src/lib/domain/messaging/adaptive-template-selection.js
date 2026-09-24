/**
 * ADAPTIVE TEMPLATE SELECTION.
 *
 * Chooses the best APPROVED template for a conversation, and — when the
 * provider content-filters one — the next best approved template for the SAME
 * intent. It selects among stored, approved copy. It does not generate,
 * mutate or paraphrase text, and it is not a carrier-filter workaround.
 *
 * WHAT THE PRODUCTION DATA SAYS.
 *   Within one estate and one intent (S1 ownership_check), measured over
 *   10,080 historical attempts: one body sits at 0% content-filtered across 138
 *   attempts, another at 100% across 21. The FUS2 re-engagement family runs
 *   86–100%. 84% of every failure this system has ever recorded is a content
 *   filter. So the lever is which approved body is chosen, and the evidence to
 *   choose with already exists.
 *
 * TWO PHASES, IN THIS ORDER, ALWAYS.
 *   1. HARD ELIGIBILITY — a boolean gate. Wrong stage, wrong language, wrong
 *      property class, quarantined, unresolvable variables, already attempted:
 *      excluded outright. Performance cannot buy a way past this. An S3 message
 *      is never satisfied by an S1 body however well that body delivers.
 *   2. RANKING — orders only what survived phase 1.
 *
 * Collapsing those into one weighted score is the tempting shortcut and it is
 * wrong: it lets a brilliantly-performing wrong-stage template outrank a
 * correct one, which is how a seller at S3 gets asked to confirm ownership
 * again.
 */

const clean = (value) => String(value ?? "").trim();
const lower = (value) => clean(value).toLowerCase();

/** Mirrors the generated column `sms_templates.variant_group_key`. */
export function buildVariantGroupKey({ stage_code, use_case, language, property_type_scope } = {}) {
  return [
    clean(stage_code) || "nostage",
    clean(use_case) || "nouse",
    clean(language) || "nolang",
    clean(property_type_scope) || "any",
  ].join("|");
}

/**
 * Wilson lower bound on a proportion.
 *
 * Why not the raw rate: a template that delivered 1/1 shows 100% and would
 * outrank one that delivered 129/138 (93.5%) — ranking the estate by which
 * template has been tried least. The lower bound of the confidence interval
 * asks "what is the worst this is plausibly worth", so evidence has to be
 * earned. 1/1 scores ~0.21; 129/138 scores ~0.88.
 *
 * z = 1.96 (95%).
 */
export function wilsonLowerBound(successes, total, z = 1.96) {
  const n = Number(total) || 0;
  if (n <= 0) return 0;
  const s = Math.max(0, Math.min(Number(successes) || 0, n));
  const phat = s / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = phat + z2 / (2 * n);
  const margin = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n);
  return Math.max(0, (centre - margin) / denominator);
}

/** Templates with less history than this are treated as unproven, not as good. */
export const MIN_MEANINGFUL_SAMPLE = 20;

/**
 * An unproven template's assumed delivery score.
 *
 * Deliberately mid-range. Set it high and brand-new copy displaces templates
 * with hundreds of clean sends; set it to zero and nothing new is ever tried,
 * so the estate can never learn. This sits below a proven good template and
 * above a proven bad one, which is the honest ordering for "we do not know".
 */
const UNPROVEN_PRIOR = 0.55;

/**
 * HARD ELIGIBILITY.
 *
 * Every exclusion returns a named reason, because "no template was available"
 * with no cause is the failure mode that hides an empty variant group.
 */
export function isEligibleVariant(template, context = {}) {
  const reject = (reason) => ({ eligible: false, reason });

  if (!template) return reject("no_template");
  if (template.is_active === false) return reject("inactive");
  if (lower(template.quarantine_state) === "quarantined") return reject("quarantined");

  // Stage must match exactly. S3 never falls back to S1.
  const wantStage = clean(context.stage_code);
  if (wantStage && clean(template.stage_code) !== wantStage) return reject("stage_mismatch");

  // Intent must match exactly.
  const wantUseCase = clean(context.use_case);
  if (wantUseCase && clean(template.use_case) !== wantUseCase) return reject("use_case_mismatch");

  /*
   * Language must match exactly, and there is no silent cross-language
   * fallback. ~20% of owners in this system are non-English; answering a
   * Spanish conversation in English because the English variant delivers
   * better is a worse outcome than not sending.
   */
  const wantLanguage = clean(context.language);
  if (wantLanguage && clean(template.language) !== wantLanguage) return reject("language_mismatch");

  // Property-context compatibility: a multifamily conversation must not be
  // answered with SFR-only copy.
  const group = clean(context.property_group);
  if (group) {
    const allowed = Array.isArray(template.allowed_property_groups) ? template.allowed_property_groups : null;
    const prohibited = Array.isArray(template.prohibited_property_groups) ? template.prohibited_property_groups : [];
    if (prohibited.map(lower).includes(lower(group))) return reject("property_group_prohibited");
    if (allowed && allowed.length > 0 && !allowed.map(lower).includes(lower(group))) {
      return reject("property_group_not_allowed");
    }
  }

  // Auto-reply surfaces may only use copy explicitly cleared for automation.
  if (context.require_auto_reply_safe && template.safe_for_auto_reply !== true) {
    return reject("not_safe_for_auto_reply");
  }

  /*
   * Every required variable must resolve. `agent_name` legitimately renders ''
   * when an owner has no assigned agent, and inserting a literal
   * "{{agent_name}}" puts broken copy in front of a seller.
   *
   * `skip_variable_check` is for callers that render immediately afterwards and
   * discard anything that fails to render -- there, checking here with a
   * partial view of the personalization would reject bodies the real renderer
   * can fill. It is an explicit opt-out, never a default.
   */
  if (!context.skip_variable_check) {
    const unresolved = unresolvedVariables(template, context.variables ?? {});
    if (unresolved.length > 0) return reject(`unresolved_variables:${unresolved.join(",")}`);
  }

  // §3: one body per logical communication, ever.
  const attempted = new Set((context.attempted_template_ids ?? []).map(clean).filter(Boolean));
  if (attempted.has(clean(template.template_id))) return reject("already_attempted_in_this_communication");

  return { eligible: true, reason: null };
}

/** Variable tokens in the body that the context cannot fill. */
export function unresolvedVariables(template, variables = {}) {
  const body = clean(template?.template_body);
  if (!body) return [];
  const tokens = body.match(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g) ?? [];
  const missing = [];
  for (const token of tokens) {
    const name = token.replace(/[{}\s]/g, "");
    const value = variables[name];
    if (value === undefined || value === null || clean(value) === "") {
      if (!missing.includes(name)) missing.push(name);
    }
  }
  return missing;
}

/**
 * Score one eligible template. Higher is better.
 *
 * Deliberately a small, readable weighted sum rather than a learned model:
 * every number here has to be explainable to an operator asking why a
 * particular body was chosen for a particular seller.
 */
export function scoreVariant(template, performance = null, options = {}) {
  const attempts = Number(performance?.attempts ?? 0);
  const proven = attempts >= (options.minSample ?? MIN_MEANINGFUL_SAMPLE);

  const delivery = proven
    ? wilsonLowerBound(Number(performance?.delivered ?? 0), attempts)
    : UNPROVEN_PRIOR;

  /*
   * Content filtering is penalised on its UPPER bound, the mirror of scoring
   * delivery on its lower bound. Both choices are pessimistic on purpose: a
   * template gets the benefit of the doubt on neither its successes nor its
   * failures, so sparse evidence cannot make copy look safe.
   */
  const filterUpper = proven
    ? 1 - wilsonLowerBound(attempts - Number(performance?.content_filtered ?? 0), attempts)
    : 1 - UNPROVEN_PRIOR;

  /*
   * RECENCY. Carrier behaviour changes; a template with a clean lifetime record
   * that started being filtered this week must fall now, not after its lifetime
   * average catches up. Only consulted when the recent window is itself big
   * enough to mean something.
   */
  const attempts7d = Number(performance?.attempts_7d ?? 0);
  const recentPenalty =
    attempts7d >= (options.minRecentSample ?? 10)
      ? Number(performance?.content_filter_rate_7d ?? 0)
      : 0;

  /*
   * SENDER SEGMENT (§25). Consulted only when that specific sender has enough
   * history with this specific body; otherwise the global number stands. Never
   * a blocker — an unknown carrier must not stop a send.
   */
  const senderAttempts = Number(options.senderPerformance?.attempts ?? 0);
  const senderPenalty =
    senderAttempts >= (options.minSenderSample ?? 20)
      ? Number(options.senderPerformance?.content_filter_rate ?? 0)
      : 0;

  const replyRate = Number(performance?.reply_rate ?? 0);

  const score =
    delivery * 1.0 -
    filterUpper * 0.8 -
    recentPenalty * 0.6 -
    senderPenalty * 0.3 +
    replyRate * 0.25 +
    // A caller-supplied hint breaks ties only; it cannot outweigh measured
    // deliverability, so a hand-set rank can never resurrect filtered copy.
    (Number.isFinite(Number(template?.fallback_rank)) ? (1 / (1 + Number(template.fallback_rank))) * 0.05 : 0);

  return {
    score,
    proven,
    attempts,
    delivery_score: delivery,
    content_filter_penalty: filterUpper,
    recent_penalty: recentPenalty,
    sender_penalty: senderPenalty,
  };
}

/**
 * Select the next template for this logical communication.
 *
 * @returns {{ok:true, template, selection_reason, rank, of, components}
 *          |{ok:false, reason, rejected}}
 */
export function selectVariant(candidates = [], context = {}, options = {}) {
  const performanceById = options.performanceByTemplateId ?? {};
  const senderById = options.senderPerformanceByTemplateId ?? {};

  const rejected = [];
  const eligible = [];
  for (const template of candidates) {
    const verdict = isEligibleVariant(template, context);
    if (!verdict.eligible) {
      rejected.push({ template_id: clean(template?.template_id), reason: verdict.reason });
      continue;
    }
    eligible.push(template);
  }

  if (eligible.length === 0) {
    return { ok: false, reason: "no_eligible_variant", rejected };
  }

  const scored = eligible
    .map((template) => {
      const id = clean(template.template_id);
      return {
        template,
        ...scoreVariant(template, performanceById[id] ?? null, {
          ...options,
          senderPerformance: senderById[id] ?? null,
        }),
      };
    })
    /*
     * The minimal fallback is held back to LAST within its group regardless of
     * score. It exists to be the final low-complexity attempt after richer copy
     * has been filtered — promoting it on score would spend the group's last
     * resort first and leave nothing behind it.
     */
    .sort((a, b) => {
      const aMin = a.template.minimal_fallback ? 1 : 0;
      const bMin = b.template.minimal_fallback ? 1 : 0;
      if (aMin !== bMin) return aMin - bMin;
      if (b.score !== a.score) return b.score - a.score;
      // Deterministic tiebreak: the same inputs must always yield the same body.
      return clean(a.template.template_id).localeCompare(clean(b.template.template_id));
    });

  const winner = scored[0];
  const attemptNumber = Number(context.variant_attempt_number ?? 1);

  const selection_reason = [
    `stage=${clean(context.stage_code) || "any"}`,
    `intent=${clean(context.use_case) || "any"}`,
    `language=${clean(context.language) || "any"}`,
    `attempt=${attemptNumber}`,
    context.previous_failure_class ? `previous_failure=${clean(context.previous_failure_class)}` : null,
    `rank=1_of_remaining_${scored.length}`,
    `delivery_score=${winner.delivery_score.toFixed(3)}`,
    `filter_penalty=${winner.content_filter_penalty.toFixed(3)}`,
    winner.proven ? `sample=${winner.attempts}` : "sample=unproven",
  ]
    .filter(Boolean)
    .join(" ");

  return {
    ok: true,
    template: winner.template,
    selection_reason,
    rank: 1,
    of: scored.length,
    components: {
      score: winner.score,
      proven: winner.proven,
      attempts: winner.attempts,
      delivery_score: winner.delivery_score,
      content_filter_penalty: winner.content_filter_penalty,
      recent_penalty: winner.recent_penalty,
      sender_penalty: winner.sender_penalty,
    },
    rejected,
  };
}

export default selectVariant;
