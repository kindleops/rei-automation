// Workflow Studio V2 — conversation fact extraction and persistence.

import { getDefaultSupabaseClient } from '@/lib/supabase/default-client.js';

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

function asNumber(value) {
  const parsed = Number(String(value ?? '').replace(/[$,]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function db(deps = {}) {
  return deps.supabase ?? deps.supabaseClient ?? getDefaultSupabaseClient();
}

function extractPrice(text) {
  const match = String(text ?? '').match(/\$?\s*([0-9]{2,3}(?:,[0-9]{3})+|[0-9]{4,7})(?:\.\d{1,2})?/);
  if (!match) return null;
  return asNumber(match[1]);
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

export function extractConversationFacts({ message = {}, enrollment = {}, deps = {} } = {}) {
  const text = clean(message.body ?? message.message_body ?? message.text ?? '');
  const lowerText = lower(text);
  const sourceMessageId = clean(message.id ?? message.message_id ?? message.source_message_id ?? '');
  const ctx = enrollment?.context && typeof enrollment.context === 'object' ? enrollment.context : {};
  const facts = [];

  if (lowerText.includes('not the owner') || lowerText.includes('wrong person')) {
    facts.push(buildFact('ownership_status', 'not_owner', 0.82, 'message_regex', sourceMessageId));
  } else if (lowerText.includes('i own') || lowerText.includes('this is my property')) {
    facts.push(buildFact('ownership_status', 'owner_confirmed', 0.78, 'message_regex', sourceMessageId));
  }

  if (lowerText.includes('not interested') || lowerText.includes('stop texting')) {
    facts.push(buildFact('seller_interest_level', 'not_interested', 0.9, 'message_regex', sourceMessageId));
  } else if (lowerText.includes('maybe') || lowerText.includes('depends')) {
    facts.push(buildFact('seller_interest_level', 'latent_interest', 0.7, 'message_regex', sourceMessageId));
  } else if (lowerText.includes('interested') || lowerText.includes('sell')) {
    facts.push(buildFact('seller_interest_level', 'interested', 0.75, 'message_regex', sourceMessageId));
  }

  const askingPrice = extractPrice(text);
  if (askingPrice) {
    facts.push(buildFact('asking_price', askingPrice, 0.85, 'message_regex', sourceMessageId));
  } else if (ctx.asking_price) {
    facts.push(buildFact('asking_price', ctx.asking_price, 0.6, 'enrollment_context', sourceMessageId));
  }

  if (lowerText.includes('spouse') || lowerText.includes('partner decides')) {
    facts.push(buildFact('decision_maker_status', 'not_decision_maker', 0.72, 'message_regex', sourceMessageId));
  }

  if (lowerText.includes('foreclosure') || lowerText.includes('behind on payments')) {
    facts.push(buildFact('seller_motivation', 'financial_distress', 0.8, 'message_regex', sourceMessageId));
  } else if (lowerText.includes('relocat') || lowerText.includes('moving')) {
    facts.push(buildFact('seller_motivation', 'relocation', 0.72, 'message_regex', sourceMessageId));
  }

  if (lowerText.includes('roof') || lowerText.includes('needs work') || lowerText.includes('fixer')) {
    facts.push(buildFact('property_condition', 'needs_repairs', 0.7, 'message_regex', sourceMessageId));
  }

  if (lowerText.includes('30 day') || lowerText.includes('asap') || lowerText.includes('soon')) {
    facts.push(buildFact('timeline_to_sell', 'short', 0.68, 'message_regex', sourceMessageId));
  }

  if (lowerText.includes('call me') || lowerText.includes('phone')) {
    facts.push(buildFact('preferred_contact_method', 'phone', 0.65, 'message_regex', sourceMessageId));
  } else if (lowerText.includes('email')) {
    facts.push(buildFact('preferred_contact_method', 'email', 0.65, 'message_regex', sourceMessageId));
  }

  if (lowerText.includes('español') || lowerText.includes('spanish')) {
    facts.push(buildFact('language', 'es', 0.8, 'message_regex', sourceMessageId));
  }

  if (lowerText.includes('too low') || lowerText.includes('not enough')) {
    facts.push(buildFact('objection_type', 'price_too_low', 0.74, 'message_regex', sourceMessageId));
  }

  const classifier = deps.classifier ?? deps.classify;
  if (typeof classifier === 'function' && text) {
    try {
      const classification = classifier({ text, enrollment, message });
      const intent = clean(classification?.primary_intent ?? classification?.detected_intent ?? '');
      if (intent) {
        facts.push(
          buildFact(
            'classification_intent',
            intent,
            Number(classification?.confidence) || 0.55,
            'classifier',
            sourceMessageId,
          ),
        );
      }
    } catch {
      // Graceful degradation — regex facts still returned.
    }
  }

  const deduped = new Map();
  for (const fact of facts) {
    const existing = deduped.get(fact.fact_key);
    if (!existing || fact.confidence > existing.confidence) {
      deduped.set(fact.fact_key, fact);
    }
  }

  return {
    ok: true,
    facts: [...deduped.values()],
    source_message_id: sourceMessageId || null,
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