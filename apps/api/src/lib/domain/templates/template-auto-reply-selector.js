// Supabase-only template selection for autonomous replies — no English fallback.

import { hasSupabaseConfig, supabase as defaultSupabase } from '@/lib/supabase/client.js';
import {
  normalizeCanonicalLanguage,
  normalizeCanonicalUseCase,
  normalizeCanonicalStageCode,
  normalizeTouchNumber,
} from '@/lib/domain/templates/template-metadata-normalization.js';
import { isTemplateEligibleForSend } from '@/lib/domain/templates/template-lifecycle.js';

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

  const { data, error } = await client
    .from('sms_templates')
    .select('*')
    .eq('is_active', true)
    .eq('use_case', use_case)
    .eq('language', language)
    .limit(50);

  if (error) return { ok: false, reason: 'template_query_failed', error: error.message };

  const candidates = (data ?? []).filter((row) => {
    const lifecycle = isTemplateEligibleForSend(row, { autonomous: true });
    if (!lifecycle.ok) return false;
    const rowStage = normalizeCanonicalStageCode({ use_case: row.use_case, stage_code: row.stage_code });
    if (stage_code && rowStage && rowStage !== stage_code) return false;
    return true;
  });

  if (!candidates.length) {
    return {
      ok: false,
      reason: 'no_approved_template_for_language',
      use_case,
      language,
      stage_code,
      touch_number,
    };
  }

  const template = candidates[0];
  return {
    ok: true,
    template,
    use_case,
    language,
    stage_code,
    touch_number,
    candidate_count: candidates.length,
  };
}

export default { selectApprovedTemplateForAutoReply };