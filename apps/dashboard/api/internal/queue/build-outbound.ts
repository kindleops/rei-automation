import { getSupabaseClient } from '../../../src/lib/supabaseClient'
import { getSupabaseAdminClient } from '../_lib/supabaseAdmin'
import { checkSuppression, generateDedupeKey, scheduleWithWindow, checkExistingQueue, renderMessage, checkRepeatContactAndBlacklist } from './utils'
import { asString, normalizeStatus, asNumber } from '../../../src/lib/data/shared'
import { selectWeightedTemplate } from './templateSelection'
import { resolveOutboundTextgridNumber } from '../../../src/lib/data/textgridRouting'

type ApiRequest = {
  method?: string
  body?: any
}

type ApiResponse = {
  status: (code: number) => ApiResponse
  json: (body: any) => void
}

function normalizeOutboundLanguage(raw: string): string {
  if (!raw) return 'English'
  const lower = raw.toLowerCase().trim()
  if (lower === 'english' || lower === 'en') return 'English'
  if (lower === 'spanish' || lower === 'es') return 'Spanish'
  return 'English'
}

function normalizeAssetClass(contact: any): string {
  const unitsCount = asNumber(contact.units_count) || 0
  if (unitsCount >= 5) return 'apartment'
  if (unitsCount >= 2 && unitsCount <= 4) return 'multifamily'

  const propType = asString(contact.property_type || '').toLowerCase()
  if (propType.includes('apartment')) return 'apartment'
  if (propType.includes('multi') || propType.includes('duplex') || propType.includes('triplex') || propType.includes('fourplex')) {
    return 'multifamily'
  }
  
  return 'single_family'
}

function resolveSellerFacingAgentName(contact: any, selectedTemplate: any): string {
  const assigned = asString(contact.agent_name || contact.assigned_agent_name || contact.agent_persona || '').trim()
  const templateAgent = asString(selectedTemplate?.paired_with_agent_type || '').trim()
  
  const candidates = [assigned, templateAgent]
  
  const isForbidden = (name: string) => {
    const lower = name.toLowerCase()
    return lower === 'nexus' || lower === 'ryan' || lower === 'reivesti' || lower === ''
  }

  for (const name of candidates) {
    if (name && !isForbidden(name)) {
      const firstName = name.split(' ')[0]
      if (!isForbidden(firstName)) {
        return firstName
      }
    }
  }

  const lang = asString(selectedTemplate?.language || contact.language || 'English').toLowerCase()
  if (lang === 'spanish' || lang === 'es') {
    return 'Alejandro'
  }
  return 'Sarah'
}

function resolvePropertyReference(fullAddress: string, streetOnly: string): string {
  if (streetOnly && streetOnly.trim().length > 0) {
    return streetOnly.trim()
  }
  if (!fullAddress) return ''
  // Split by comma and return first part to strip city/state/zip
  return fullAddress.split(',')[0].trim()
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (process.env.NEXUS_ALLOW_BACKEND_MUTATION !== 'true') {
    res.status(403).json({
      error: 'BOUNDARY_VIOLATION',
      message: 'Backend mutation scripts must run from real-estate-automation, not nexus-dashboard.',
      hint: 'Queue building belongs in real-estate-automation. Set NEXUS_ALLOW_BACKEND_MUTATION=true only for authorized incident response.'
    })
    return
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const supabase = getSupabaseAdminClient()
  const results: any[] = []

  try {
    const dryRun = req.body?.dry_run !== false && req.body?.apply !== true
    const apply = req.body?.apply === true && req.body?.dry_run === false
    const limit = Math.min(100, Number(req.body?.limit || 50))
    const allowClusterRouting = req.body?.allow_cluster_routing !== false

    // 1. Check available columns to safely add filters
    const { data: colsCheck } = await supabase.from('v_sms_ready_contacts').select('*').limit(1)
    const availableCols = colsCheck && colsCheck[0] ? Object.keys(colsCheck[0]) : []

    let query = supabase.from('v_sms_ready_contacts').select('*').eq('sms_eligible', true)

    if (availableCols.includes('last_outbound_at')) {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
      query = query.or(`last_outbound_at.is.null,last_outbound_at.lt.${thirtyDaysAgo}`)
    }
    if (availableCols.includes('touch_number')) {
      query = query.or(`touch_number.is.null,touch_number.eq.0`)
    }
    if (availableCols.includes('current_stage')) {
      query = query.or(`current_stage.is.null,current_stage.eq.new`)
    }
    if (availableCols.includes('contact_status')) {
      query = query.not('contact_status', 'in', ['opted_out', 'dnc', 'wrong_number', 'suppressed'])
    }

    if (availableCols.includes('last_outbound_at')) {
      query = query.order('last_outbound_at', { ascending: true, nullsFirst: true })
    } else if (availableCols.includes('priority_tier')) {
      // Default to priority ordering if no last_outbound_at
      query = query.order('priority_tier', { ascending: true, nullsFirst: true })
    }

    // Fetch more than limit to allow for in-batch deduplication
    const fetchLimit = limit * 3
    const { data: contacts, error: fetchError } = await query.limit(fetchLimit)

    if (fetchError) throw fetchError

    const seenProspects = new Set<string>()
    const seenPhones = new Set<string>()
    const seenCombos = new Set<string>()

    let processedCount = 0

    for (const contact of (contacts || [])) {
      if (processedCount >= limit) break

      const phone = asString(contact.canonical_e164 || contact.phone || '')
      const prospectId = asString(contact.canonical_prospect_id || contact.prospect_id || '')
      const propertyId = asString(contact.property_id || '')
      const market = asString(contact.market || '')
      const threadKey = `new:${prospectId}:${propertyId}`
      const comboKey = `${propertyId}:${prospectId}`

      // Spread candidate selection / avoid hammering in the same batch
      if (seenProspects.has(prospectId) || seenPhones.has(phone) || seenCombos.has(comboKey)) {
        continue
      }
      
      const rawLanguage = asString(contact.language || '').trim()
      const language = normalizeOutboundLanguage(rawLanguage)
      const assetClass = normalizeAssetClass(contact)

      // 2. Weighted Template Selection
      let selected = await selectWeightedTemplate({
        market,
        language,
        assetClass
      })

      if (!selected) {
        results.push({ prospectId, status: 'blocked', reason: 'no_eligible_controlled_template' })
        continue
      }
      
      seenProspects.add(prospectId)
      seenPhones.add(phone)
      seenCombos.add(comboKey)
      processedCount++

      const city = asString(contact.property_city || contact.property_address_city || '');
      const zip = asString(contact.property_zip || contact.property_address_zip || '');
      const county = asString(contact.property_county || contact.property_address_county_name || '');

      const requiresCity = selected.template_text.includes('{{city}}') && !city;
      const requiresZip = selected.template_text.includes('{{zip}}') && !zip;
      const requiresCounty = selected.template_text.includes('{{county}}') && !county;
      const unsupportedLang = selected.language && selected.language !== language;

      if (requiresCity || requiresZip || requiresCounty || unsupportedLang) {
        const missing = [];
        if (requiresCity) missing.push('city');
        if (requiresZip) missing.push('zip');
        if (requiresCounty) missing.push('county');
        if (unsupportedLang) missing.push('language_mismatch');

        results.push({ prospectId, status: 'blocked', reason: 'template_missing_required_variables', missingVariables: missing })
        continue
      }

      // 3. Suppression Gate
      const suppression = await checkSuppression({
        phone,
        masterOwnerId: contact.master_owner_id,
        prospectId
      })

      if (suppression.blocked) {
        results.push({ prospectId, status: 'blocked', reason: suppression.reason })
        continue
      }

      // 3.5 Repeat Contact and Blacklist Gate
      const repeatCheck = await checkRepeatContactAndBlacklist({
        phone,
        prospectId,
        masterOwnerId: contact.master_owner_id,
        propertyId,
        stageCode: 'ownership_check',
        touchNumber: 1
      })

      if (!repeatCheck.safe) {
        results.push({ prospectId, status: 'blocked', reason: repeatCheck.reason })
        continue
      }

      // 4. Dedupe Check
      const dedupeKey = generateDedupeKey({
        threadKey,
        phone,
        queueType: 'first_touch',
        stageCode: 'ownership_check',
        touchNumber: 1
      })

      if (await checkExistingQueue(dedupeKey)) {
        results.push({ prospectId, status: 'skipped', reason: 'Duplicate already exists' })
        continue
      }

      // 5. Message Rendering
      const sellerFacingAgentName = resolveSellerFacingAgentName(contact, selected)
      const fullAddress = asString(contact.property_address_full || contact.property_address || '')
      const streetAddress = asString(contact.property_street || contact.property_address_street || '')
      const propertyReference = resolvePropertyReference(fullAddress, streetAddress)

      const usedFallback = false;
      if (usedFallback) {
        throw new Error('Fallback is not allowed');
      }

      const context = {
        seller_first_name: asString(contact.prospect_first_name || contact.display_name?.split(' ')[0] || ''),
        property_address_full: fullAddress,
        property_reference: propertyReference,
        property_street: propertyReference,
        property_address: propertyReference, // Default to short street reference for first touch
        market,
        agent_name: sellerFacingAgentName,
        internal_system_name: 'Nexus',
        city,
        zip,
        county
      }
      
      // Creating a mock template object for rendering
      const mockTemplate = { templateText: selected.template_text } as any
      const rendered = renderMessage(mockTemplate, context)
      
      if (!rendered.ok) {
        results.push({ prospectId, status: 'blocked', reason: rendered.reason })
        continue
      }

      // 6. Sender Routing
      const routingResult = await resolveOutboundTextgridNumber({
        marketId: asString(contact.market_id || ''),
        market: market,
        ourNumber: undefined,
        phoneNumber: phone,
        textgridNumberId: undefined,
        property_address_state: asString(contact.property_address_state || ''),
        propertyId: propertyId,
        threadKey: threadKey,
        allow_cluster_routing: allowClusterRouting
      })

      if (!routingResult.ok) {
        results.push({
          prospectId,
          status: 'blocked',
          reason: 'no_valid_textgrid_sender',
          routingBlockReason: routingResult.error || 'Unknown routing error'
        })
        continue
      }

      // 7. Scheduling
      const scheduledAt = scheduleWithWindow(new Date(), contact.timezone || 'America/Chicago')
      // Add batch spread (3 mins per item to avoid blasting)
      scheduledAt.setMinutes(scheduledAt.getMinutes() + (processedCount * 3))

      // 8. Queue the Outbound with selection metadata
      const payload = {
        queue_key: `outbound:${prospectId}:${Date.now()}`,
        dedupe_key: dedupeKey,
        queue_status: 'scheduled',
        to_phone_number: phone,
        from_phone_number: routingResult.from_phone_number,
        textgrid_number_id: routingResult.textgrid_number_id,
        template_id: selected.template_id,
        message_body: rendered.text,
        message_text: rendered.text,
        scheduled_for: scheduledAt.toISOString(),
        scheduled_for_utc: scheduledAt.toISOString(),
        send_priority: 5,
        type: 'first_touch',
        current_stage: 'ownership_check',
        touch_number: 1,
        master_owner_id: contact.master_owner_id,
        property_id: contact.property_id,
        prospect_id: prospectId,
        market: contact.market,
        property_address_state: asString(contact.property_address_state || ''),
        routing_allowed: true,
        routing_tier: routingResult.routing_tier,
        routing_reason: routingResult.routing_reason,
        // Metadata for observability
        metadata: {
          template_id: selected.template_id,
          template_name: selected.template_id,
          template_score: selected.score,
          template_recommendation: selected.recommendation,
          template_selection_reason: selected.reason,
          template_selection_bucket: selected.bucket,
          template_source: 'weighted_outbound_builder',
          agent_name: sellerFacingAgentName,
          asset_class: assetClass,
          language: language,
          selected_from_control_table: true,
          used_fallback: false,
          routing_allowed: true,
          selected_textgrid_number: routingResult.from_phone_number,
          selected_textgrid_number_id: routingResult.textgrid_number_id,
          selected_textgrid_market: routingResult.route_input_market,
          routing_tier: routingResult.routing_tier,
          selection_reason: routingResult.routing_reason,
          routing_cluster: routingResult.routing_cluster
        }
      }

      if (dryRun) {
        results.push({
          prospectId,
          status: 'would_queue',
          dedupeKey,
          template_id: selected.template_id,
          template_name: selected.template_id,
          template_source: 'weighted_outbound_builder',
          agent_name: sellerFacingAgentName,
          language: language,
          assetClass: assetClass,
          template_text_raw: selected.template_text,
          rendered_preview: rendered.text,
          selected_from_control_table: true,
          usedFallback: false,
          fallbackBlocked: true,
          scheduledAt: scheduledAt.toISOString(),
          preview: rendered.text,
          fromPhoneNumber: routingResult.from_phone_number,
          textgridNumberId: routingResult.textgrid_number_id,
          selectedTextgridMarket: routingResult.route_input_market,
          routingTier: routingResult.routing_tier,
          routingReason: routingResult.routing_reason,
          routingCluster: routingResult.routing_cluster
        })
      } else if (apply) {
        if (!payload.from_phone_number || !payload.textgrid_number_id) {
          throw new Error('Cannot insert send_queue row without from_phone_number and textgrid_number_id')
        }
        const { error: insertError } = await supabase.from('send_queue').insert(payload)
        if (insertError) {
          results.push({ prospectId, status: 'failed', reason: insertError.message })
        } else {
          results.push({ prospectId, status: 'queued', dedupeKey, template_id: selected.template_id })
        }
      }
    }

    res.status(200).json({ ok: true, processed: results.length, results })
  } catch (error) {
    console.error('[Build Outbound Error]:', error)
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to build outbound' })
  }
}

