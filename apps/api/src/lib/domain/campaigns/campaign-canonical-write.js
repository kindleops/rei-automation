/**
 * Normalize legacy aliases to canonical persisted values at write time.
 */

import { normalizeCampaignStageCode } from '@/lib/domain/campaigns/campaign-stage-code.js'
import {
  canonicalLanguageLabel,
  resolveLanguage,
} from '@/lib/domain/campaigns/campaign-canonical-language.js'
import {
  buildExecutionModeMetadata,
  resolveCampaignExecutionMode,
} from '@/lib/domain/campaigns/campaign-execution-mode.js'
import { CANONICAL_FULL_AUTOPILOT_MODE } from '@/lib/domain/campaigns/campaign-live-execution.js'

const MARKET_ALIASES = Object.freeze({
  la: 'Los Angeles, CA',
  'los angeles': 'Los Angeles, CA',
  'los angeles ca': 'Los Angeles, CA',
  'los angeles, ca': 'Los Angeles, CA',
  miami: 'Miami, FL',
  'miami fl': 'Miami, FL',
  'miami, fl': 'Miami, FL',
  dallas: 'Dallas, TX',
  'dallas tx': 'Dallas, TX',
  'dallas, tx': 'Dallas, TX',
  houston: 'Houston, TX',
  'houston tx': 'Houston, TX',
  'houston, tx': 'Houston, TX',
  charlotte: 'Charlotte, NC',
  'charlotte nc': 'Charlotte, NC',
  'charlotte, nc': 'Charlotte, NC',
  atlanta: 'Atlanta, GA',
  'atlanta ga': 'Atlanta, GA',
  'atlanta, ga': 'Atlanta, GA',
  minneapolis: 'Minneapolis, MN',
  'minneapolis mn': 'Minneapolis, MN',
  'minneapolis, mn': 'Minneapolis, MN',
  jacksonville: 'Jacksonville, FL',
  'jacksonville fl': 'Jacksonville, FL',
  'jacksonville, fl': 'Jacksonville, FL',
})

function clean(value) {
  return String(value ?? '').trim()
}

function metadataObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

export function normalizeCanonicalMarket(value, fallback = null) {
  const raw = clean(value)
  if (!raw) return fallback
  const key = raw.toLowerCase()
  return MARKET_ALIASES[key] || raw
}

export function normalizeCanonicalCampaignWrite(input = {}, campaign = {}) {
  const metadata = metadataObject(campaign.metadata)
  const mergedMetadata = {
    ...metadata,
    ...metadataObject(input.metadata),
    stage_code: normalizeCampaignStageCode(
      input.stage_code || input.stageCode || metadata.stage_code || 'S1',
      'S1'
    ),
    template_use_case: clean(
      input.template_use_case ||
        input.templateUseCase ||
        metadata.template_use_case ||
        campaign.objective ||
        'ownership_check'
    ) || 'ownership_check',
    language: canonicalLanguageLabel(
      input.language || metadata.language || campaign.language_policy
    ),
    execution_mode: resolveCampaignExecutionMode(campaign, input),
  }

  const languageResolved = resolveLanguage(mergedMetadata.language)
  if (languageResolved.canonical) {
    mergedMetadata.language = languageResolved.canonical
  }

  return {
    market: normalizeCanonicalMarket(input.market || campaign.market, campaign.market),
    state: clean(input.state || campaign.state || metadata.state) || null,
    language_policy: clean(input.language_policy || campaign.language_policy) || 'auto',
    auto_reply_mode: clean(input.auto_reply_mode || campaign.auto_reply_mode) || 'disabled',
    contact_window_start: clean(input.contact_window_start || campaign.contact_window_start) || '08:00',
    contact_window_end: clean(input.contact_window_end || campaign.contact_window_end) || '21:00',
    metadata: {
      ...mergedMetadata,
      ...buildExecutionModeMetadata(campaign, input, mergedMetadata),
      production_launch:
        input.production_launch === true ||
        metadata.production_launch === true ||
        input.production_live_write === true,
    },
  }
}

export function buildProductionLiveCampaignPersistencePatch(campaign = {}, schedule = {}, input = {}) {
  const now = new Date().toISOString()
  const normalized = normalizeCanonicalCampaignWrite(input, campaign)
  const executionMode = resolveCampaignExecutionMode(campaign, input)
  const isLive =
    executionMode === 'immediate_live' || executionMode === 'scheduled_live'

  return {
    ...normalized,
    status: clean(input.status || campaign.status || 'active'),
    auto_queue_enabled: isLive,
    auto_send_enabled: isLive,
    auto_reply_mode: isLive ? CANONICAL_FULL_AUTOPILOT_MODE : clean(campaign.auto_reply_mode) || 'disabled',
    scheduled_for: schedule.scheduled_for || campaign.scheduled_for || null,
    activated_at: campaign.activated_at || (isLive ? now : null),
    execution_heartbeat_at: now,
    metadata: {
      ...normalized.metadata,
      converted_to_live_at: isLive ? normalized.metadata.converted_to_live_at || now : normalized.metadata.converted_to_live_at,
      production_launch: isLive,
      test_mode_cleared: isLive,
      launch_timezone: schedule.timezone || normalized.metadata.launch_timezone || null,
      launch_window: schedule.window_start
        ? { start: schedule.window_start, end: schedule.window_end }
        : normalized.metadata.launch_window || null,
    },
  }
}