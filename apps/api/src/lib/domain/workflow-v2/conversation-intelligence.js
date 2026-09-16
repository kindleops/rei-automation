// Workflow Studio V2 — conversation fact extraction and persistence.

import { getDefaultSupabaseClient } from '@/lib/supabase/default-client.js';

import { normalizeCanonicalIntent } from '@/lib/domain/seller-flow/coverage-net/canonical-intent-aliases.js';

export const FACT_KEYS = Object.freeze([
  'ownership_status',
  'decision_maker_status',
  'seller_interest_level',
  'asking_price',
  'seller_motivation',
  'property_condition',
  'timeline_to_sell',
  'preferred_contact_method',
  'language',
  'objection_type',
  'classification_intent',
  'underwriting_readiness',
]);

function clean(value) {
  return String(value ?? '').trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function db(deps = {}) {
  return deps.supabase ?? deps.supabaseClient ?? getDefaultSupabaseClient();
}

function buildFact(key, value, confidence, provenance, sourceMessageId) {
  return {
    fact_key: key,
    fact_value: { value },
    confidence: Math.max(0, Math.min(1, Number(confidence) || 0)),
    provenance,
    source_message_id: sourceMessageId,
  };
}

/**
 * §14 — the workflow engine CONSUMES canonical outcomes. It does not
 * reinterpret seller language.
 *
 * WHAT THIS REPLACED, and why it mattered. This function was a parallel
 * seller-language interpretation engine: eleven regex families with twelve
 * hand-picked confidence constants, deriving ownership, interest, price,
 * decision-maker, motivation, condition, timeline, contact preference,
 * language and objection from raw message text. The canonical classifier was
 * called too, but only to ADD an intent fact — the regex facts were returned
 * regardless, and the catch block said so: "regex facts still returned".
 *
 * Four published workflows carry `action.run_conversation_extraction`,
 * including Asking Price Extraction, so this sat on the money axis. Concrete
 * defects, each of which the canonical engines already handle properly and have
 * critical tests for:
 *
 *   - `'stop texting'` produced `seller_interest_level: not_interested` at 0.9.
 *     That is an OPT-OUT, and grading it as mere disinterest under-reacts to a
 *     DNC signal.
 *   - `lowerText.includes('sell')` produced `interested` at 0.75, so
 *     "I will never sell" read as interest.
 *   - `'30 day'|'asap'|'soon'` produced `timeline_to_sell: short`, which
 *     stage2-offer-interest-engine.js explicitly guards against ("Guards
 *     against time expressions").
 *   - `'español'|'spanish'` produced `language: 'es'`, which is not even the
 *     canonical language vocabulary ('Spanish'), so it would have poisoned
 *     template language selection.
 *   - a bare price regex with no scale or cue guards, on the axis where
 *     Spanish "mil" has already been misread as a million once.
 *
 * Everything below is either a canonical value read from the enrollment context
 * or a pure mapping of a CANONICAL INTENT, which is not interpretation. Absent
 * canonical data yields NO fact and a stated reason — never a guess.
 */

/**
 * Canonical intent -> the fact it already implies. A restatement of a decision
 * the classifier has made, not a second opinion about the seller's words.
 * Intents not listed here imply nothing about interest, and say nothing.
 */
const INTENT_TO_INTEREST = Object.freeze({
  not_interested: 'not_interested',
  seller_interested: 'interested',
  asks_offer: 'interested',
  asking_price_provided: 'interested',
  contract_requested: 'interested',
  latent_interest: 'latent_interest',
  need_time: 'latent_interest',
  // opt_out is deliberately absent: suppression is a compliance state decided
  // at the send boundary, not an interest level. Collapsing them is the defect
  // this rewrite removes.
});

const INTENT_TO_OWNERSHIP = Object.freeze({
  ownership_confirmed: 'owner_confirmed',
  wrong_number: 'not_owner',
  property_specific_non_owner: 'not_owner',
  non_owner_referral: 'not_owner',
});

/** Canonical fact keys that may be copied straight from canonical context. */
const CONTEXT_FACT_SOURCES = Object.freeze([
  ['asking_price', ['asking_price']],
  ['seller_motivation', ['seller_motivation', 'motivation']],
  ['property_condition', ['property_condition', 'condition']],
  ['timeline_to_sell', ['timeline_to_sell', 'timeline']],
  ['decision_maker_status', ['decision_maker_status']],
  ['preferred_contact_method', ['preferred_contact_method']],
  ['objection_type', ['objection_type', 'objection']],
  ['underwriting_readiness', ['underwriting_readiness']],
]);

function firstDefined(sources, keys) {
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const key of keys) {
      const raw = source[key];
      const value = raw && typeof raw === 'object' && 'value' in raw ? raw.value : raw;
      if (value !== undefined && value !== null && value !== '') return value;
    }
  }
  return undefined;
}

// `deps` is accepted and ignored: the previous implementation used it to reach
// a classifier and then merged the result with its own regex findings. Canonical
// classification arrives on the enrollment context, written by
// action.run_classification, so there is nothing to call from here.
export function extractConversationFacts({ message = {}, enrollment = {} } = {}) {
  const sourceMessageId = clean(message.id ?? message.message_id ?? message.source_message_id ?? '');
  const ctx = enrollment?.context && typeof enrollment.context === 'object' ? enrollment.context : {};
  const facts = [];

  const classification = ctx.classification && typeof ctx.classification === 'object' ? ctx.classification : {};
  const rawIntent = clean(
    classification.primary_intent
      ?? classification.detected_intent
      ?? ctx.classification_intent
      ?? ctx.seller_intent
      ?? '',
  );

  // The classifier's own confidence, never a substitute for it. `unclear` is
  // what normalizeCanonicalIntent returns for absent input, so it is treated as
  // "nothing stated" rather than as a finding.
  const canonicalConfidence = Number(
    classification.confidence ?? ctx.classification_confidence ?? Number.NaN,
  );
  const confidence = Number.isFinite(canonicalConfidence) ? canonicalConfidence : 0;

  let intent = null;
  if (rawIntent) {
    const normalized = normalizeCanonicalIntent(rawIntent);
    if (normalized && normalized !== 'unclear') {
      intent = normalized;
      facts.push(buildFact('classification_intent', intent, confidence, 'canonical_classification', sourceMessageId));
    }
  }

  if (intent && INTENT_TO_INTEREST[intent]) {
    facts.push(buildFact('seller_interest_level', INTENT_TO_INTEREST[intent], confidence, 'canonical_intent_mapping', sourceMessageId));
  }
  if (intent && INTENT_TO_OWNERSHIP[intent]) {
    facts.push(buildFact('ownership_status', INTENT_TO_OWNERSHIP[intent], confidence, 'canonical_intent_mapping', sourceMessageId));
  }

  // Canonical fact stores already populated upstream. `extracted_facts` entries
  // may be `{ value, confidence }` or bare values; both are handled.
  const factSources = [ctx.extracted_facts, ctx.underwriting_facts, ctx];
  for (const [factKey, keys] of CONTEXT_FACT_SOURCES) {
    const value = firstDefined(factSources, keys);
    if (value === undefined) continue;
    const entry = ctx.extracted_facts?.[keys[0]];
    const entryConfidence = entry && typeof entry === 'object' ? Number(entry.confidence) : Number.NaN;
    facts.push(buildFact(
      factKey,
      value,
      Number.isFinite(entryConfidence) ? entryConfidence : confidence,
      'enrollment_context',
      sourceMessageId,
    ));
  }

  // Language is canonical (prospects.language_preference, resolved through the
  // canonical language vocabulary). Read it; never infer it from a greeting.
  const language = firstDefined([ctx], ['resolved_language', 'language_preference', 'language']);
  if (language !== undefined) {
    facts.push(buildFact('language', language, confidence, 'canonical_language', sourceMessageId));
  }

  const canonicalClassifierAvailable = Boolean(rawIntent) || facts.length > 0;

  return {
    facts,
    source: 'canonical',
    // Stated so a node that produced nothing is diagnosable instead of looking
    // like a seller who said nothing of interest.
    reason: canonicalClassifierAvailable ? null : 'no_canonical_classification_on_context',
    // Explicit, because the whole point of this rewrite is that it is false.
    message_text_interpreted: false,
  };
}

export async function persistExtractedFacts(enrollment, extractedFacts = [], deps = {}) {
  const client = db(deps);
  const enrollmentId = clean(enrollment?.id ?? '');
  if (!enrollmentId) return { ok: false, error: 'enrollment_id_required' };

  const subjectType = clean(enrollment.subject_type ?? 'lead');
  const subjectId = clean(enrollment.subject_id ?? '');
  const saved = [];
  const skipped = [];

  for (const fact of extractedFacts) {
    const factKey = clean(fact.fact_key ?? '');
    if (!factKey) continue;

    const existingRes = await client
      .from('workflow_extracted_facts')
      .select('*')
      .eq('enrollment_id', enrollmentId)
      .eq('fact_key', factKey)
      .maybeSingle();
    if (existingRes.error) throw existingRes.error;

    const existing = existingRes.data;
    const incomingConfidence = Number(fact.confidence) || 0;
    const existingConfidence = Number(existing?.confidence) || 0;
    const existingConfirmed =
      lower(existing?.provenance) === 'confirmed' || existing?.fact_value?.confirmed === true;

    if (existing && (existingConfirmed || existingConfidence > incomingConfidence)) {
      skipped.push({ fact_key: factKey, reason: 'higher_confidence_existing' });
      continue;
    }

    const row = {
      enrollment_id: enrollmentId,
      subject_type: subjectType,
      subject_id: subjectId,
      fact_key: factKey,
      fact_value: fact.fact_value ?? { value: fact.value ?? null },
      confidence: incomingConfidence,
      provenance: clean(fact.provenance ?? 'extracted') || 'extracted',
      source_message_id: clean(fact.source_message_id ?? '') || null,
      updated_at: new Date().toISOString(),
    };

    const upsert = existing
      ? await client
          .from('workflow_extracted_facts')
          .update(row)
          .eq('id', existing.id)
          .select('*')
          .single()
      : await client.from('workflow_extracted_facts').insert(row).select('*').single();
    if (upsert.error) throw upsert.error;
    saved.push(upsert.data);
  }

  return { ok: true, saved, skipped };
}