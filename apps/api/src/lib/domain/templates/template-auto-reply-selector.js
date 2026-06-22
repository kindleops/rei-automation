// Supabase template selection — catalog-driven, no English fallback.

import { hasSupabaseConfig, supabase as defaultSupabase } from '@/lib/supabase/client.js';
import {
  normalizeCanonicalLanguage,
  normalizeCanonicalUseCase,
  normalizeCanonicalStageCode,
  normalizeTouchNumber,
} from '@/lib/domain/templates/template-metadata-normalization.js';
import { resolveTemplateFromPool } from '@/lib/domain/templates/template-runtime-resolver.js';

function clean(value) {
  return String(value ?? '').trim();
}

export async function selectApprovedTemplateForAutoReply(input = {}, deps = {}) {
  const client = deps.supabase ?? defaultSupabase;
  const use_case = normalizeCanonicalUseCase(input.use_case);
  const language = normalizeCanonicalLanguage(input.language);
  const stage_code = normalizeCanonicalStageCode({
    use_case,
    stage_code: input.stage_code,
    touch_number: input.touch_number,
  });
  const touch_number = normalizeTouchNumber(input);

  if (!use_case) return { ok: false, reason: 'missing_use_case' };
  if (!language) return { ok: false, reason: 'missing_language' };

  if (!hasSupabaseConfig() || !client?.from) {
    return { ok: false, reason: 'supabase_not_configured' };
  }

  let query = client.from('sms_templates').select('*').eq('is_active', true);
  if (use_case) query = query.eq('use_case', use_case);
  if (language) query = query.eq('language', language);

  const { data, error } = await query.limit(200);
  if (error) return { ok: false, reason: 'template_query_failed', error: error.message };

  const resolved = resolveTemplateFromPool(
    {
      ...input,
      use_case,
      language,
      stage_code,
      touch_number,
    },
    data ?? [],
  );

  if (!resolved.ok) {
    return {
      ok: false,
      reason: resolved.reason,
      use_case,
      language,
      stage_code,
      touch_number,
      candidate_pool_size: resolved.candidate_pool_size ?? 0,
      excluded_candidates: resolved.excluded_candidates,
      resolver_version: resolved.resolver_version,
    };
  }

  return {
    ok: true,
    template: resolved.template,
    template_id: resolved.template_id,
    use_case,
    language,
    stage_code,
    touch_number,
    candidate_count: resolved.candidate_pool_size,
    candidate_pool_size: resolved.candidate_pool_size,
    match_dimensions: resolved.match_dimensions,
    ranking_reason: resolved.ranking_reason,
    excluded_candidates: resolved.excluded_candidates,
    resolver_version: resolved.resolver_version,
  };
}

export default { selectApprovedTemplateForAutoReply };