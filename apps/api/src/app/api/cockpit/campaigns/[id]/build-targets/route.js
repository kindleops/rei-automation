import { NextResponse } from 'next/server';
import supabase from '@/lib/supabase/client';

export async function POST(request, { params }) {
  try {
    const { id: campaign_id } = await params;
    
    // 1. Fetch the campaign to get the configuration
    const { data: campaign, error: campErr } = await supabase
      .from('sms_campaigns')
      .select('*')
      .eq('campaign_id', campaign_id)
      .single();
      
    if (campErr) throw campErr;
    if (!campaign) throw new Error('Campaign not found');

    const target_filters = campaign.metadata?.target_filters || {};

    // 2. Query properties/contacts based on filters
    let query = supabase.from('v_sms_ready_contacts').select('*');
    
    // 1. HARDCODED AUTOMATIC SYSTEM GUARDRAILS (Contact Safety)
    query = query.eq('sms_eligible', true);
    query = query.not('canonical_e164', 'is', null);
    query = query.not('property_id', 'is', null);
    query = query.not('master_owner_id', 'is', null);
    query = query.neq('suppression_status', 'opt_out');
    query = query.neq('suppression_status', 'wrong_number');
    query = query.neq('suppression_status', 'not_interested');

    // 2. Apply Filters (same logic as preview)
    if (target_filters.states?.length > 0) query = query.in('property_address_state', target_filters.states);
    if (target_filters.markets?.length > 0) query = query.in('market', target_filters.markets);
    if (target_filters.owner_types?.length > 0) query = query.in('owner_type', target_filters.owner_types);
    if (target_filters.likely_owner_required) query = query.eq('person_flag_likely_owner', true);
    if (target_filters.min_final_acquisition_score > 0) query = query.gte('final_acquisition_score', target_filters.min_final_acquisition_score);
    if (target_filters.min_equity_percent > 0) query = query.gte('equity_percent', target_filters.min_equity_percent);
    if (target_filters.tags_include_any?.length > 0) query = query.overlaps('property_tags', target_filters.tags_include_any);
    if (target_filters.tags_include_all?.length > 0) query = query.contains('property_tags', target_filters.tags_include_all);

    // Limit to prevent massive blowouts during testing
    const { data: candidates, error: queryErr } = await query.limit(5000);
    if (queryErr) throw queryErr;
    
    if (!candidates || candidates.length === 0) {
      return NextResponse.json({ success: true, built_count: 0, message: 'No targets matched the filters.' });
    }

    // 3. Deduplication and Suppression in memory for the batch
    const uniquePhones = new Set();
    const uniqueOwners = new Set();
    const targetsToInsert = [];

    for (const c of candidates) {
      if (!c.canonical_e164 || !c.property_id) continue;
      
      if (target_filters.dedupe_same_phone && uniquePhones.has(c.canonical_e164)) continue;
      if (target_filters.dedupe_same_owner && c.master_owner_id && uniqueOwners.has(c.master_owner_id)) continue;

      uniquePhones.add(c.canonical_e164);
      if (c.master_owner_id) uniqueOwners.add(c.master_owner_id);

      targetsToInsert.push({
        campaign_id,
        master_owner_id: c.master_owner_id,
        property_id: c.property_id,
        phone_id: c.phone_id,
        canonical_e164: c.canonical_e164,
        property_address_full: c.property_address_full,
        property_address_city: c.property_address_city,
        property_address_state: c.property_address_state,
        property_address_zip: c.property_address_zip,
        market: c.market,
        timezone: c.timezone,
        seller_name: c.seller_name || c.display_name,
        seller_first_name: c.seller_first_name || c.first_name,
        best_language: c.best_language || target_filters.language || 'english',
        agent_persona: target_filters.agent_persona || 'friendly',
        agent_family: target_filters.agent_family || '',
        final_acquisition_score: c.final_acquisition_score,
        cash_offer: c.cash_offer,
        estimated_value: c.estimated_value,
        equity_percent: c.equity_percent,
        target_status: 'ready',
        metadata: {
          property_tags: c.property_tags,
          owner_type: c.owner_type,
          source_view: campaign.source_view
        }
      });
    }

    // 4. Insert targets in chunks of 1000
    let insertedCount = 0;
    const chunkSize = 1000;
    for (let i = 0; i < targetsToInsert.length; i += chunkSize) {
      const chunk = targetsToInsert.slice(i, i + chunkSize);
      const { error: insertErr } = await supabase.from('sms_campaign_targets').insert(chunk);
      if (insertErr) {
        console.error('Insert chunk error:', insertErr);
        throw insertErr;
      }
      insertedCount += chunk.length;
    }

    // 5. Update campaign status
    await supabase.from('sms_campaigns').update({ status: 'targets_built' }).eq('campaign_id', campaign_id);

    return NextResponse.json({ success: true, built_count: insertedCount });
  } catch (err) {
    console.error('Build targets error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
