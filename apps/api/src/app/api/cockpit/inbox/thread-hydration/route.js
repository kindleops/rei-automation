import { NextResponse } from 'next/server.js'
import { ensureMutationAuth, corsHeaders } from '../../_shared.js'
import { getThreadMessages } from '@/lib/domain/inbox/live-inbox-service.js'
import { getUniversalDealDossier } from '@/lib/cockpit/universal-deal-dossier-service.js'
import { supabase } from '@/lib/supabase/client.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function clean(value) {
  return String(value ?? '').trim()
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function parseConversationThreadId(value) {
  const text = clean(value)
  if (!text.startsWith('ct:')) return {}
  const parsed = {}
  for (const segment of text.slice(3).split('|')) {
    const splitAt = segment.indexOf(':')
    if (splitAt <= 0) continue
    const key = segment.slice(0, splitAt)
    const rawValue = segment.slice(splitAt + 1)
    if (!rawValue) continue
    if (key === 'prospect') parsed.prospect_id = rawValue
    if (key === 'property') parsed.property_id = rawValue
    if (key === 'owner') parsed.master_owner_id = rawValue
    if (key === 'phone') parsed.normalized_phone = rawValue
  }
  return parsed
}

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

const withTimeout = (promiseFn, ms, timeoutErrorString) => {
  const controller = new AbortController();
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error(timeoutErrorString));
    }, ms);
  });
  
  const safePromise = promiseFn(controller.signal).catch(err => {
    if (err.name === 'AbortError' || err.message?.includes('AbortError')) {
      return null; // resolve to null so Next.js doesn't wait forever
    }
    throw err;
  });

  return Promise.race([
    safePromise,
    timeoutPromise
  ]).finally(() => {
    clearTimeout(timeoutId);
  });
};

export async function GET(request) {
  const headers = corsHeaders(request)
  const startedAt = Date.now()

  try {
    const auth = ensureMutationAuth(request)
    if (!auth.ok) return auth.response

    const { searchParams } = new URL(request.url)
    const thread_key = clean(searchParams.get('thread_key'))
    const conversation_thread_id = clean(searchParams.get('conversation_thread_id') || searchParams.get('conversationThreadId'))
    const legacy_thread_key = clean(searchParams.get('legacy_thread_key') || searchParams.get('legacyThreadKey'))
    const normalized_phone = clean(searchParams.get('normalized_phone') || searchParams.get('normalizedPhone'))
    const canonical_e164 = clean(searchParams.get('canonical_e164'))
    const phone_e164 = clean(searchParams.get('phone_e164'))
    const phone = clean(searchParams.get('phone'))
    const best_phone = clean(searchParams.get('best_phone'))
    const seller_phone = clean(searchParams.get('seller_phone'))
    const property_id = clean(searchParams.get('property_id'))
    const prospect_id = clean(searchParams.get('prospect_id'))
    const master_owner_id = clean(searchParams.get('master_owner_id') || searchParams.get('owner_id'))
    const latest_message_id = clean(searchParams.get('latest_message_id') || searchParams.get('latestMessageId'))
    const debug = searchParams.get('debug') === 'true'

    const parsedIdentity = parseConversationThreadId(conversation_thread_id || thread_key)
    const effective_normalized_phone = normalized_phone || parsedIdentity.normalized_phone || canonical_e164 || phone_e164 || phone || best_phone || seller_phone || ''
    const effective_property_id = property_id || parsedIdentity.property_id || ''
    const effective_prospect_id = prospect_id || parsedIdentity.prospect_id || ''
    const effective_master_owner_id = master_owner_id || parsedIdentity.master_owner_id || ''

    const target_thread_key = thread_key || conversation_thread_id || legacy_thread_key
    const degradedParts = []

    console.log('[HYDRATION] 1. Fetching fallback data...')
    let fallbackData = {}
    if (target_thread_key) {
      const { data } = await supabase
        .from('canonical_inbox_threads')
        .select('property_address_full, owner_name, market, property_type, estimated_value, canonical_e164, latest_message_body, latest_message_at, property_id, master_owner_id, prospect_id')
        .eq('thread_key', target_thread_key)
        .maybeSingle()
      if (data) fallbackData = data
    }

    const resolved_e164 = effective_normalized_phone || fallbackData.canonical_e164 || ''
    const resolved_property_id = effective_property_id || fallbackData.property_id || ''
    const resolved_master_owner_id = effective_master_owner_id || fallbackData.master_owner_id || ''
    const resolved_prospect_id = effective_prospect_id || fallbackData.prospect_id || ''

    console.log('[HYDRATION] 2. Fetching Messages directly...')
    let messagesPayload = { rows: [], total: 0, diagnostics: {}, threadKey: target_thread_key || null }
    try {
      messagesPayload = await getThreadMessages({
        selected_thread_key: target_thread_key,
        conversation_thread_id,
        legacy_thread_key,
        normalized_phone: resolved_e164,
        canonical_e164: resolved_e164,
        phone_e164,
        phone,
        best_phone,
        seller_phone,
        property_id: resolved_property_id,
        prospect_id: resolved_prospect_id,
        master_owner_id: resolved_master_owner_id,
        latest_message_id: latest_message_id || null,
      }, { offset: 0, limit: 50 }, {
        latestPreviewSource: 'canonical_inbox_threads',
      })
      console.log('[HYDRATION] Messages fetched successfully', messagesPayload.rows.length)
    } catch (error) {
      console.error('[HYDRATION] [MESSAGES_ERROR]', error)
      degradedParts.push('messages')
    }

    console.log('[HYDRATION] 3. Fetching Dossier with Timeout...')
    let dossier = null
    let dossierError = null
    
    try {
      dossier = await withTimeout((signal) => getUniversalDealDossier({
        thread_key: target_thread_key,
        property_id: resolved_property_id,
        prospect_id: resolved_prospect_id,
        master_owner_id: resolved_master_owner_id,
        canonical_e164: resolved_e164,
        abortSignal: signal,
        debug
      }), 2500, 'universal_dossier_timeout')
      
      console.log('[HYDRATION] Dossier fetched successfully')
      if (!dossier.identity.property_id) degradedParts.push('property_id_missing')
    } catch (error) {
      console.error('[HYDRATION] [DOSSIER_HYDRATION_ERROR]', error.message)
      degradedParts.push('dossier')
      dossierError = error?.message || 'Unknown error'

      dossier = {
        identity: {
          thread_key: target_thread_key,
          property_id: resolved_property_id,
          prospect_id: resolved_prospect_id,
          master_owner_id: resolved_master_owner_id,
          canonical_e164: resolved_e164
        },
        property: {
          full_address: fallbackData.property_address_full,
          address: fallbackData.property_address_full,
          market: fallbackData.market,
          property_type: fallbackData.property_type,
          estimated_value: fallbackData.estimated_value
        },
        prospect: {
          full_name: fallbackData.owner_name
        },
        master_owner: {
          full_name: fallbackData.owner_name
        },
        primary_phone: {
          canonical_e164: fallbackData.canonical_e164
        },
        conversation: {
          latest_message_body: fallbackData.latest_message_body,
          latest_message_at: fallbackData.latest_message_at
        },
        compliance: {},
        deal_status: {},
        valuation: {
          estimated_value: fallbackData.estimated_value
        },
        raw_sources_debug: {
          command_raw: {
            thread_key: target_thread_key,
            property_address_full: fallbackData.property_address_full,
            owner_name: fallbackData.owner_name,
            market: fallbackData.market,
            property_type: fallbackData.property_type,
            estimated_value: fallbackData.estimated_value
          }
        }
      }
    }

    // 4. Map Dossier back to hydration response for compatibility
    const response = {
      ok: true,
      degraded: degradedParts.length > 0,
      integrity_blocked: messagesPayload.integrityBlocked === true,
      thread: dossier.raw_sources_debug?.command_raw || {
        thread_key: dossier.identity.thread_key,
        property_id: dossier.identity.property_id,
        prospect_id: dossier.identity.prospect_id,
        master_owner_id: dossier.identity.master_owner_id,
        canonical_e164: dossier.identity.canonical_e164,
        property_address_full: fallbackData.property_address_full,
        owner_name: fallbackData.owner_name,
        market: fallbackData.market,
        property_type: fallbackData.property_type,
        estimated_value: fallbackData.estimated_value
      },
      messages: messagesPayload?.rows || [],
      property: dossier.property,
      prospect: dossier.prospect,
      owner: dossier.master_owner,
      master_owner: dossier.master_owner,
      phone: dossier.primary_phone,
      deal_context: dossier,
      deal_intelligence: dossier,
      valuation: dossier.valuation,
      routing: {
        seller_phone: dossier.primary_phone?.canonical_e164,
        sender_phone: dossier.conversation?.sender_phone,
        textgrid_number_id: dossier.conversation?.textgrid_number_id,
      },
      outreach: {
        suppression_status: dossier.compliance?.is_suppressed ? 'suppressed' : null,
        inbox_bucket: dossier.conversation?.inbox_status,
        queue_status: dossier.conversation?.queue_status,
        reply_intent: dossier.conversation?.seller_intent,
        lead_temperature: dossier.conversation?.lead_temperature,
      },
      degradedParts: [...new Set(degradedParts)],
      diagnostics: {
        queryMs: Date.now() - startedAt,
        threadKey: dossier.identity.thread_key,
        sourceUsed: 'universal-deal-dossier-service',
        dossier: dossier.raw_sources_debug?.diagnostics,
        error: dossierError,
        requested_key: thread_key || conversation_thread_id || legacy_thread_key,
        extracted_phone: parsedIdentity.normalized_phone || '',
        canonical_e164: resolved_e164,
        legacy_thread_key: legacy_thread_key,
        strategies_attempted: messagesPayload?.diagnostics?.strategies_tried || [],
        matched_strategy: messagesPayload?.diagnostics?.lookup_strategy_used || messagesPayload?.diagnostics?.sourceResults?.find(s => s.ok && s.rows > 0)?.strategy || 'unknown',
        message_count: messagesPayload?.rows?.length || 0
      }
    }

    return NextResponse.json(response, { status: 200, headers })
  } catch (error) {
    console.error('[THREAD_HYDRATION_FATAL]', error)
    return NextResponse.json(
      {
        ok: true,
        degraded: true,
        error_code: 'thread_hydration_fatal',
        error: error?.message || 'Unknown thread hydration error',
        degradedParts: ['fatal'],
      },
      { status: 200, headers },
    )
  }
}
