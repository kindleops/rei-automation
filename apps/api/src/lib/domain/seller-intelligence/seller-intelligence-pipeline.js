/**
 * seller-intelligence-pipeline.js
 *
 * CANONICAL COMMUNICATION IN, CANONICAL INTELLIGENCE OUT.
 *
 * This is the seam EMAIL-5 will call, and the reason it exists is a promise:
 * EMAIL-5 must never parse seller prose again. Everything it needs to decide
 * what should happen next is in the object this returns.
 *
 * ── THE ORDER IS THE ARCHITECTURE ─────────────────────────────────────────
 *
 *   1 PROTOCOL      is this even a seller talking? An auto-reply, a bounce or a
 *                   duplicate never reaches semantic extraction at all. Asking
 *                   a model to rediscover a header is waste, and running an
 *                   extractor over a mailer-daemon is how a bounce becomes a
 *                   seller's asking price.
 *   2 ATTRIBUTION   whose words are these?
 *   3 DETERMINISTIC what can be read by rule, at explicit basis.
 *   4 MODEL         the genuinely semantic part, as an ENRICHMENT -- optional,
 *                   bounded, validated, and unable to overwrite step 3.
 *   5 RECONCILE     what any of it is allowed to change.
 *
 * Each step can only narrow what the next one may do. Nothing later can promote
 * something earlier to a stronger basis, and nothing at all reaches canonical
 * state without passing step 5.
 *
 * ── CHANNEL-INDEPENDENT ───────────────────────────────────────────────────
 *
 * Nothing in this file branches on channel. It takes a canonical communication
 * -- SMS, email, or a future transcript -- and channel survives only as
 * provenance on the assertions it produces.
 *
 * ── IT DECIDES NOTHING ────────────────────────────────────────────────────
 *
 * No reply is composed, no offer is generated, no stage is advanced, no
 * authority is granted. The output is what Reivesti now UNDERSTANDS. What
 * should happen next is EMAIL-5's question, and this file deliberately cannot
 * answer it.
 */

import { asObject } from "@/lib/hostile-input.js";
import { INBOUND_MESSAGE_CLASS } from "@/lib/domain/email/inbound/inbound-email-contract.js";
import { assembleExtractionContext } from "@/lib/domain/seller-intelligence/context-assembler.js";
import { extractDeterministicAssertions } from "@/lib/domain/seller-intelligence/deterministic-extraction.js";
import { validateExtractionOutput } from "@/lib/domain/seller-intelligence/extraction-output-contract.js";
import {
  reconcileAssertion,
  RECONCILIATION,
} from "@/lib/domain/seller-intelligence/reconciliation-policy.js";
import { ACTION_AUTHORITY } from "@/lib/domain/seller-intelligence/assertion-contract.js";

export const PIPELINE_VERSION = "seller_intelligence_pipeline_v1";

/**
 * Message classes that are NOT a seller talking, and must never reach semantic
 * extraction. Deterministic, from headers -- see EMAIL-3's classifier.
 */
const NON_SELLER_CLASSES = Object.freeze(new Set([
  INBOUND_MESSAGE_CLASS.AUTO_REPLY,
  INBOUND_MESSAGE_CLASS.DELIVERY_STATUS,
  INBOUND_MESSAGE_CLASS.SYSTEM_OR_LIST,
  INBOUND_MESSAGE_CLASS.MALFORMED,
]));

function clean(value) {
  return String(value ?? "").trim();
}

/**
 * Run one canonical communication through the intelligence pipeline.
 *
 * @param {object} input
 * @param {object} input.communication  { channel, text|body, received_at, message_class }
 * @param {object} [input.conversation] canonical conversation anchors
 * @param {Array}  [input.prior_messages]
 * @param {Array}  [input.current_assertions] what we already believe
 * @param {object} [deps] { extractWithModel, now }
 * @returns {object} the EMAIL-5 handoff object
 */
export async function runSellerIntelligence(raw_input, deps = {}) {
  const input = asObject(raw_input);
  const communication = asObject(input.communication);
  const channel = clean(communication.channel) || "email";
  const received_at = clean(communication.received_at) || clean(deps.now) || new Date().toISOString();

  // ── 1. protocol: is this a seller at all? ───────────────────────────────
  const message_class = clean(communication.message_class) || INBOUND_MESSAGE_CLASS.HUMAN_REPLY;
  if (NON_SELLER_CLASSES.has(message_class)) {
    // A bounce run through an extractor is how a mailer-daemon acquires an
    // asking price. It is bypassed, not analysed.
    return handoff({
      communication, channel, skipped: true,
      skip_reason: `not_a_seller_message:${message_class}`,
    });
  }
  if (input.duplicate === true) {
    return handoff({ communication, channel, skipped: true, skip_reason: "duplicate_communication" });
  }

  // ── 2. context ──────────────────────────────────────────────────────────
  const assembled = assembleExtractionContext({
    current_message: {
      channel,
      received_at,
      text: clean(communication.text ?? asObject(communication.body).newest_reply ?? communication.body),
    },
    conversation: input.conversation,
    prior_messages: input.prior_messages,
    current_assertions: input.current_assertions,
  });

  if (!assembled.ok) {
    return handoff({ communication, channel, skipped: true, skip_reason: assembled.reason });
  }

  // ── 3. deterministic, first and always ──────────────────────────────────
  const deterministic = extractDeterministicAssertions({
    body: communication.body ?? { newest_reply: assembled.context.current_message.text },
    received_at,
  });

  const assertions = [...deterministic.assertions];
  const rejected = [...deterministic.rejected];

  // ── 4. the model, as an enrichment that cannot overwrite ────────────────
  let model_meta = null;
  if (typeof deps.extractWithModel === "function") {
    try {
      const raw = await deps.extractWithModel({
        context: assembled.context,
        context_hash: assembled.context_hash,
      });
      const validated = validateExtractionOutput(asObject(raw).output ?? raw);
      model_meta = {
        provider: clean(asObject(raw).provider) || null,
        model: clean(asObject(raw).model) || null,
        prompt_version: clean(asObject(raw).prompt_version) || null,
        schema_version: validated.schema_version,
        input_tokens: asObject(raw).input_tokens ?? null,
        output_tokens: asObject(raw).output_tokens ?? null,
        latency_ms: asObject(raw).latency_ms ?? null,
      };
      rejected.push(...validated.rejected);

      for (const candidate of validated.assertions) {
        // The model may ADD what the rules could not read. It may not restate
        // what they did: a model-proposed duplicate of a deterministic fact
        // would arrive at a basis the model chose, and that is how an explicit
        // fact quietly becomes an inference.
        const already = assertions.some((existing) => existing.type === candidate.type);
        if (already) {
          rejected.push({ reason: "model_duplicated_deterministic_assertion", detail: candidate.type });
          continue;
        }
        assertions.push(candidate);
      }
      model_meta.intents = validated.intents;
      model_meta.questions = validated.questions;
      model_meta.objections = validated.objections;
      model_meta.review_flags = validated.review_flags;
    } catch (error) {
      // A model failure degrades to the deterministic floor. The seller's price
      // and conditions are already extracted; what is lost is the interpretive
      // layer, which is the right thing to lose.
      rejected.push({ reason: "model_extraction_failed", detail: clean(error?.message).slice(0, 120) });
      model_meta = { failed: true, reason: clean(error?.message).slice(0, 120) };
    }
  }

  // ── 5. reconcile ────────────────────────────────────────────────────────
  const current_by_type = new Map(
    (Array.isArray(input.current_assertions) ? input.current_assertions : [])
      .map((entry) => [clean(asObject(entry).type), asObject(entry)])
  );

  const reconciliation = { accepted: [], soft: [], review: [], refused: [] };
  for (const assertion of assertions) {
    const decision = reconcileAssertion({
      assertion,
      current: current_by_type.get(assertion.type) ?? null,
      context: asObject(input.reconciliation_context),
    });

    const entry = { assertion, decision };
    if (decision.outcome === RECONCILIATION.ACCEPT) reconciliation.accepted.push(entry);
    else if (decision.outcome === RECONCILIATION.SOFT) reconciliation.soft.push(entry);
    else if (decision.outcome === RECONCILIATION.REVIEW) reconciliation.review.push(entry);
    else reconciliation.refused.push(entry);
  }

  return handoff({
    communication,
    channel,
    context_hash: assembled.context_hash,
    assertions,
    rejected,
    reconciliation,
    model: model_meta,
    deterministic_version: deterministic.extractor_version,
    attribution: deterministic.attribution,
  });
}

/**
 * The EMAIL-5 handoff object.
 *
 * Shaped so its only reasonable question is "given everything we now understand
 * about this seller and this opportunity, what should happen next?" -- and so
 * that answering it requires no access to the original prose.
 */
function handoff(parts) {
  const {
    communication = {}, channel, skipped = false, skip_reason = null,
    context_hash = null, assertions = [], rejected = [],
    reconciliation = { accepted: [], soft: [], review: [], refused: [] },
    model = null, deterministic_version = null, attribution = null,
  } = parts;

  return {
    pipeline_version: PIPELINE_VERSION,
    communication_id: clean(communication.id) || null,
    conversation_id: clean(communication.conversation_id) || null,
    channel,

    skipped,
    skip_reason,

    intelligence: {
      intents: model?.intents ?? [],
      assertions,
      questions: model?.questions ?? [],
      objections: model?.objections ?? [],
      // Preferences and conditions are not separate lists: they are assertions,
      // and duplicating them here would create two places to look and one of
      // them would drift.
      review_flags: [
        ...(model?.review_flags ?? []),
        ...reconciliation.review.map((entry) => entry.decision.reason),
      ],
      rejected,
    },

    reconciliation: {
      accepted: reconciliation.accepted,
      soft: reconciliation.soft,
      review: reconciliation.review,
      refused: reconciliation.refused,
    },

    // What EMAIL-4 believes should become canonical. Writing it is the store's
    // job; deciding it is the policy's; this only reports it.
    canonical_state: Object.fromEntries(
      reconciliation.accepted.map((entry) => [entry.assertion.type, entry.assertion.value])
    ),

    provenance: {
      context_hash,
      deterministic_version,
      model: model ? { ...model, intents: undefined, questions: undefined, objections: undefined, review_flags: undefined } : null,
      attribution_source: attribution?.source ?? null,
      attribution_ambiguous: attribution?.ambiguous ?? false,
    },

    // Layer D, stated rather than implied. EMAIL-4 understands; it does not act.
    authority: ACTION_AUTHORITY.NONE,
  };
}

export default runSellerIntelligence;
