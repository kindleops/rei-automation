/**
 * Canonical campaign stage codes for template resolution (sms_templates uses S1/S2/...).
 */

function clean(value) {
  return String(value ?? '').trim()
}

export function normalizeCampaignStageCode(value, fallback = 'S1') {
  const raw = clean(value).toLowerCase()
  if (!raw) return fallback
  if (raw === 'first_touch' || raw === 'first-touch' || raw === 'touch_1' || raw === 'touch1') return 'S1'
  if (raw === 'second_touch' || raw === 'follow_up' || raw === 'touch_2' || raw === 'touch2') return 'S2'
  if (raw === 'third_touch' || raw === 'touch_3' || raw === 'touch3') return 'S3'
  const upper = clean(value).toUpperCase()
  return upper || fallback
}