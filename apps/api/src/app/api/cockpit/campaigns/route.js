import { NextResponse } from 'next/server';
import supabase from '@/lib/supabase/client';

export async function POST(request) {
  try {
    const payload = await request.json();
    
    // As per user spec:
    // Create a real campaign row in public.sms_campaigns.
    // Store all campaign configuration inside metadata.target_filters 
    // if target_filters column does not exist.
    
    const row = {
      campaign_name: payload.campaign_name,
      status: 'draft',
      source_view: payload.source_view || 'v_sms_ready_contacts',
      target_goal_count: payload.target_goal_count || null,
      max_total_sends: payload.max_total_sends || null,
      auto_send_enabled: payload.auto_send_enabled || false,
      health_guard_enabled: payload.health_guard_enabled || true,
      send_window_policy: payload.send_window_policy || 'national_et_to_pt',
      send_window_start_time: payload.send_window_start_time || '08:00',
      send_window_start_timezone: payload.send_window_start_timezone || 'America/New_York',
      send_window_end_time: payload.send_window_end_time || '20:00',
      send_window_end_timezone: payload.send_window_end_timezone || 'America/Los_Angeles',
      send_interval_seconds: payload.send_interval_seconds || 15,
      max_sends_per_number_per_day: payload.max_sends_per_number_per_day || 200,
      max_sends_per_market_per_day: payload.max_sends_per_market_per_day || 1000,
      pause_on_blacklist_rate: payload.pause_on_blacklist_rate || 5,
      pause_on_optout_rate: payload.pause_on_optout_rate || 5,
      pause_on_failure_rate: payload.pause_on_failure_rate || 5,
      metadata: payload.metadata || {}
    };

    const { data, error } = await supabase
      .from('sms_campaigns')
      .insert([row])
      .select('campaign_id')
      .single();

    if (error) {
      // In case the new columns don't exist yet on sms_campaigns, fallback to dumping into metadata
      if (error.message.includes('column') && error.message.includes('does not exist')) {
        console.warn('Falling back to pure metadata insert for sms_campaigns due to missing columns');
        const fallbackRow = {
          campaign_name: payload.campaign_name,
          status: 'draft',
          metadata: { ...row }
        };
        const fallbackReq = await supabase.from('sms_campaigns').insert([fallbackRow]).select('campaign_id').single();
        if (fallbackReq.error) throw fallbackReq.error;
        return NextResponse.json({ success: true, campaign_id: fallbackReq.data.campaign_id });
      }
      throw error;
    }

    return NextResponse.json({ success: true, campaign_id: data.campaign_id });
  } catch (err) {
    console.error('Create campaign error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
