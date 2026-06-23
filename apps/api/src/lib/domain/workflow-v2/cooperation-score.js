// Workflow Studio V2 — seller cooperation scoring.

import { getDefaultSupabaseClient } from '@/lib/supabase/default-client.js';
import { updateEnrollmentContext } from '@/lib/domain/workflow-v2/enrollment-service.js';

function clean(value) {
  return String(value ?? '').trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function asNumber(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function db(deps = {}) {
  return deps.supabase ?? deps.supabaseClient ?? getDefaultSupabaseClient();
}

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function calculateSellerCooperation(enrollment = {}, facts = [], deps = {}) {
  const ctx = enrollment?.context && typeof enrollment.context === 'object' ? enrollment.context : {};
  let score = 55;
  const reasons = [];

  const factMap = new Map((facts ?? []).map((fact) => [fact.fact_key, fact]));
  const interest = lower(
    factMap.get('seller_interest_level')?.fact_value?.value ??
      ctx.seller_interest_level ??
      ctx.interest_level ??
      '',
  );
  if (interest === 'interested') {
    score += 18;
    reasons.push({ delta: 18, reason: 'seller_interested' });
  } else if (interest === 'latent_interest') {
    score += 8;
    reasons.push({ delta: 8, reason: 'latent_interest' });
  } else if (interest === 'not_interested') {
    score -= 25;
    reasons.push({ delta: -25, reason: 'not_interested' });
  }

  const avgResponseHours = asNumber(
    ctx.avg_response_time_hours ?? deps.metrics?.avg_response_time_hours,
    null,
  );
  if (avgResponseHours !== null) {
    if (avgResponseHours <= 4) {
      score += 12;
      reasons.push({ delta: 12, reason: 'fast_response' });
    } else if (avgResponseHours >= 48) {
      score -= 10;
      reasons.push({ delta: -10, reason: 'slow_response' });
    }
  }

  const questionCompletionRate = asNumber(
    ctx.question_completion_rate ?? deps.metrics?.question_completion_rate,
    null,
  );
  if (questionCompletionRate !== null) {
    if (questionCompletionRate >= 0.75) {
      score += 10;
      reasons.push({ delta: 10, reason: 'high_question_completion' });
    } else if (questionCompletionRate < 0.35) {
      score -= 8;
      reasons.push({ delta: -8, reason: 'low_question_completion' });
    }
  }

  if (ctx.hostile_language === true || lower(ctx.sentiment) === 'hostile') {
    score -= 20;
    reasons.push({ delta: -20, reason: 'hostile_language' });
  }

  // Profanity alone is not treated as hostility.
  if (ctx.profanity_detected === true && ctx.hostile_language !== true) {
    score -= 2;
    reasons.push({ delta: -2, reason: 'profanity_without_hostility' });
  }

  const priorScore = asNumber(ctx.seller_cooperation_score, null);
  let trend = 'stable';
  const finalScore = clampScore(score);
  if (priorScore !== null) {
    if (finalScore > priorScore + 5) trend = 'improving';
    if (finalScore < priorScore - 5) trend = 'declining';
  }

  return {
    score: finalScore,
    trend,
    avg_response_time_hours: avgResponseHours,
    question_completion_rate: questionCompletionRate,
    reasons,
  };
}

export async function persistCooperationScore(enrollment, scoreResult = {}, deps = {}) {
  const client = db(deps);
  const enrollmentId = clean(enrollment?.id ?? '');
  if (!enrollmentId) return { ok: false, error: 'enrollment_id_required' };

  const row = {
    enrollment_id: enrollmentId,
    subject_type: clean(enrollment.subject_type ?? 'lead'),
    subject_id: clean(enrollment.subject_id ?? ''),
    score: clampScore(scoreResult.score ?? 0),
    trend: clean(scoreResult.trend ?? 'stable') || 'stable',
    avg_response_time_hours: scoreResult.avg_response_time_hours ?? null,
    question_completion_rate: scoreResult.question_completion_rate ?? null,
    reasons: Array.isArray(scoreResult.reasons) ? scoreResult.reasons : [],
    computed_at: new Date().toISOString(),
  };

  const insert = await client.from('workflow_seller_cooperation').insert(row).select('*').single();
  if (insert.error) throw insert.error;

  await updateEnrollmentContext(
    enrollmentId,
    {
      seller_cooperation_score: row.score,
      seller_cooperation_trend: row.trend,
      avg_response_time_hours: row.avg_response_time_hours,
      question_completion_rate: row.question_completion_rate,
    },
    deps,
  );

  return { ok: true, record: insert.data };
}