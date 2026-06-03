import { NextResponse } from 'next/server.js'
import { corsHeaders, ensureMutationAuth } from '../../_shared.js'
import { queryCampaignFieldOptions } from '@/lib/domain/campaigns/campaign-field-catalog.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const LEGACY_FIELD_MAP = Object.freeze({
  states: 'properties.property_state',
  markets: 'properties.market',
  counties: 'properties.property_county_name',
  cities: 'properties.property_address_city',
  zip_codes: 'properties.property_zip',
  property_tags: 'properties.seller_tags_text',
  property_types: 'properties.property_type',
  property_classes: 'properties.property_class',
  owner_types: 'properties.owner_type',
  owner_type_guesses: 'master_owners.owner_type_guess',
  person_flags: 'prospects.person_flags_text',
  languages: 'prospects.language_preference',
  contact_windows: 'prospects.contact_window',
  sender_markets: 'sender_coverage.selected_textgrid_market',
  template_use_cases: 'properties.options',
  stage_codes: 'properties.contact_status',
})

const EMPTY_LEGACY_KEYS = Object.freeze([
  'agent_families',
  'agent_personas',
])

function withCors(request, payload, status = 200) {
  return NextResponse.json(payload, { status, headers: corsHeaders(request) })
}

export async function OPTIONS(request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) })
}

function legacyOptionsFromResult(result) {
  return (Array.isArray(result?.options) ? result.options : []).map((option) => ({
    value: option.value,
    label: option.label,
    count: Number(option.count || 0),
    ...(option.healthy_count !== undefined ? { healthy_count: option.healthy_count } : {}),
  }))
}

export async function GET(request) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response

  try {
    const entries = await Promise.all(
      Object.entries(LEGACY_FIELD_MAP).map(async ([legacyKey, field]) => {
        const result = await queryCampaignFieldOptions({ field_key: field, limit: 250 })
        return [legacyKey, legacyOptionsFromResult(result), result]
      })
    )

    const payload = Object.fromEntries(entries.map(([key, options]) => [key, options]))
    for (const key of EMPTY_LEGACY_KEYS) payload[key] = []

    payload.sender_markets = (payload.sender_markets || []).map((option) => ({
      ...option,
      healthy_count: option.count,
    }))
    payload._diagnostics = Object.fromEntries(
      entries.map(([key, , result]) => [
        key,
        {
          field: result.field?.key || LEGACY_FIELD_MAP[key],
          sourceUsed: result.sourceUsed || null,
          sourceColumn: result.sourceColumn || null,
          countSourceUsed: result.countSourceUsed || null,
          countColumn: result.countColumn || null,
          countMeaning: result.countMeaning || null,
          warnings: result.warnings || [],
        },
      ])
    )

    return withCors(request, payload, 200)
  } catch (err) {
    console.error('campaigns.filter_options_failed', err)
    return withCors(request, {
      ok: false,
      error: 'campaign_filter_options_failed',
      message: err?.message || String(err),
    }, 500)
  }
}
