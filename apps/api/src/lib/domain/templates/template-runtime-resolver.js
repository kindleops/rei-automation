// Canonical runtime template resolver — deterministic, auditable selection.

import crypto from 'node:crypto';
import {
  normalizeCanonicalUseCase,
  normalizeCanonicalStageCode,
  normalizeTouchNumber,
} from '@/lib/domain/templates/template-metadata-normalization.js';
import {
  resolveCanonicalLanguage,
  canonicalLanguageMatches,
} from '@/lib/domain/templates/canonical-language-adapter.js';
import {
  isTemplateEligibleForSend,
  resolveTemplateLifecycleStatus,
  TEMPLATE_LIFECYCLE,
} from '@/lib/domain/templates/template-lifecycle.js';

export const RESOLVER_VERSION = '2.0.0';

function clean(value) {
  return String(value ?? '').trim();
}

function stableHash(parts = []) {
  const input = parts.map((p) => String(p ?? '')).join('|');
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 16);
}

function asNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function extractRequiredVariables(template = {}) {
  if (Array.isArray(template.variables) && template.variables.length) {
    return template.variables.map(clean).filter(Boolean);
  }
  const body = clean(template.template_body ?? template.text);
  const matches = body.match(/\{\{(\w+)\}\}/g) || [];
  return [...new Set(matches.map((m) => m.replace(/[{}]/g, '')))];
}

function mergeVariablesAvailable(template, mergeVariables = {}) {
  const required = extractRequiredVariables(template);
  const available = mergeVariables && typeof mergeVariables === 'object' ? mergeVariables : {};
  const missing = required.filter((key) => !clean(available[key]));
  return { ok: missing.length === 0, missing, required };
}

function scoreCandidate(template, context, seed) {
  let score = 0;
  const ranking_reasons = [];

  const lang = resolveCanonicalLanguage(template.language);
  const reqLang = resolveCanonicalLanguage(context.language);
  if (canonicalLanguageMatches(template.language, context.language)) {
    score += 1000;
    ranking_reasons.push('exact_language_match');
    if (lang.locale && reqLang.locale && lang.locale === reqLang.locale) {
      score += 50;
      ranking_reasons.push('exact_locale_match');
    }
  }

  const touch = normalizeTouchNumber(template);
  const reqTouch = normalizeTouchNumber(context);
  if (touch === reqTouch) {
    score += 200;
    ranking_reasons.push('touch_match');
  }

  if (context.asset_type && template.asset_type === context.asset_type) {
    score += 150;
    ranking_reasons.push('asset_type_match');
  }
  if (context.scenario && template.scenario === context.scenario) {
    score += 100;
    ranking_reasons.push('scenario_match');
  }

  const deliveryRate = asNumber(template.delivery_rate ?? template.success_rate, 0);
  const replyRate = asNumber(template.reply_rate ?? template.historical_reply_rate, 0);
  score += Math.round(deliveryRate * 10);
  score += Math.round(replyRate * 5);
  if (deliveryRate > 0) ranking_reasons.push('delivery_rate');
  if (replyRate > 0) ranking_reasons.push('reply_rate');

  const recentUse = context.recent_template_ids || [];
  if (recentUse.includes(template.id || template.template_id)) {
    score -= 500;
    ranking_reasons.push('recent_use_penalty');
  }

  // Deterministic tie-breaker
  const id = clean(template.id ?? template.template_id);
  const tie = stableHash([seed, id]);
  score += parseInt(tie.slice(0, 4), 16) / 65535;

  return { score, ranking_reasons };
}

/**
 * Resolve best template from in-memory candidate pool.
 */
export function resolveTemplateFromPool(input = {}, candidates = []) {
  const use_case = normalizeCanonicalUseCase(input.use_case);
  const language = resolveCanonicalLanguage(input.language).canonical;
  const stage_code = normalizeCanonicalStageCode({ ...input, use_case });
  const touch_number = normalizeTouchNumber(input);
  const exclude_ids = new Set(
    (input.exclude_template_ids || []).map((id) => clean(id)).filter(Boolean),
  );
  const merge_variables = input.merge_variables ?? {};
  const seed =
    input.selection_seed ||
    stableHash([stage_code, use_case, language, touch_number, input.thread_key, input.contact_id]);

  const match_dimensions = {
    stage_code,
    use_case,
    language,
    touch_number,
    asset_type: clean(input.asset_type) || null,
    scenario: clean(input.scenario) || null,
    lifecycle: TEMPLATE_LIFECYCLE.ENABLED,
  };

  const excluded = [];
  const pool = [];

  for (const row of candidates) {
    const id = clean(row.id ?? row.template_id);
    if (exclude_ids.has(id)) {
      excluded.push({ template_id: id, reason: 'excluded_by_caller' });
      continue;
    }

    const lifecycle = isTemplateEligibleForSend(row);
    if (!lifecycle.ok) {
      excluded.push({ template_id: id, reason: lifecycle.reason });
      continue;
    }

    const rowUseCase = normalizeCanonicalUseCase(row.use_case);
    if (use_case && rowUseCase && rowUseCase !== use_case) {
      excluded.push({ template_id: id, reason: 'use_case_mismatch', expected: use_case, actual: rowUseCase });
      continue;
    }

    const rowStage = normalizeCanonicalStageCode({ use_case: row.use_case, stage_code: row.stage_code });
    if (stage_code && rowStage && rowStage !== stage_code) {
      excluded.push({ template_id: id, reason: 'stage_mismatch', expected: stage_code, actual: rowStage });
      continue;
    }

    if (language && !canonicalLanguageMatches(row.language, language)) {
      excluded.push({
        template_id: id,
        reason: 'language_mismatch',
        expected: language,
        actual: row.language,
      });
      continue;
    }

    const rowTouch = normalizeTouchNumber(row);
    if (touch_number && rowTouch && rowTouch !== touch_number) {
      excluded.push({ template_id: id, reason: 'touch_mismatch', expected: touch_number, actual: rowTouch });
      continue;
    }

    if (input.asset_type && row.asset_type && row.asset_type !== input.asset_type) {
      excluded.push({ template_id: id, reason: 'asset_type_mismatch' });
      continue;
    }

    const vars = mergeVariablesAvailable(row, merge_variables);
    if (!vars.ok) {
      excluded.push({ template_id: id, reason: 'missing_merge_variables', missing: vars.missing });
      continue;
    }

    const { score, ranking_reasons } = scoreCandidate(row, { ...input, language, touch_number }, seed);
    pool.push({ template: row, template_id: id, score, ranking_reasons });
  }

  pool.sort((a, b) => b.score - a.score);

  if (!pool.length) {
    return {
      ok: false,
      reason: 'no_matching_template',
      candidate_pool_size: 0,
      match_dimensions,
      excluded_candidates: excluded,
      resolver_version: RESOLVER_VERSION,
    };
  }

  const selected = pool[0];
  return {
    ok: true,
    template: selected.template,
    template_id: selected.template_id,
    candidate_pool_size: pool.length,
    match_dimensions,
    ranking_reason: selected.ranking_reasons,
    excluded_candidates: excluded,
    resolver_version: RESOLVER_VERSION,
    lifecycle_status: resolveTemplateLifecycleStatus(selected.template),
  };
}

export default {
  RESOLVER_VERSION,
  resolveTemplateFromPool,
  extractRequiredVariables,
  mergeVariablesAvailable,
};