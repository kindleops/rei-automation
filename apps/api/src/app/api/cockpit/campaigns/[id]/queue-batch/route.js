import { NextResponse } from 'next/server';
import supabase from '@/lib/supabase/client';

export async function POST(request, { params }) {
  try {
    const { id: campaign_id } = await params;
    const { limit = 100, interval_seconds = 15 } = await request.json();

    // 1. Fetch ready targets
    const { data: targets, error: targetErr } = await supabase
      .from('sms_campaign_targets')
      .select('*')
      .eq('campaign_id', campaign_id)
      .eq('target_status', 'ready')
      .limit(limit);

    if (targetErr) throw targetErr;
    if (!targets || targets.length === 0) {
      return NextResponse.json({ success: true, queued_count: 0, message: 'No ready targets found.' });
    }

    // 2. Prepare queue rows
    const queueRows = [];
    let delaySeconds = 0;
    const now = new Date();

    for (const t of targets) {
      const scheduledTime = new Date(now.getTime() + delaySeconds * 1000);
      
      queueRows.push({
        status: 'scheduled',
        scheduled_for: scheduledTime.toISOString(),
        canonical_e164: t.canonical_e164,
        market: t.market,
        timezone: t.timezone,
        metadata: {
          campaign_id,
          campaign_target_id: t.target_id,
          seller_name: t.seller_name,
          best_language: t.best_language,
          agent_persona: t.agent_persona
        }
      });
      delaySeconds += interval_seconds;
    }

    // 3. Insert into send_queue
    const { data: insertedQueue, error: queueErr } = await supabase
      .from('send_queue')
      .insert(queueRows)
      .select('id');
      
    if (queueErr) {
      // Fallback if table schema differs (e.g., requires specific columns)
      console.error('Queue insert error:', queueErr);
      throw queueErr;
    }

    // 4. Update targets to queued
    const targetIds = targets.map(t => t.target_id || t.id); // depending on PK name
    const { error: updateErr } = await supabase
      .from('sms_campaign_targets')
      .update({ target_status: 'queued' })
      .in('target_id', targetIds);
      
    if (updateErr) {
      // Try fallback if PK is `id` instead of `target_id`
      await supabase.from('sms_campaign_targets').update({ target_status: 'queued' }).in('id', targetIds);
    }

    // 5. Update campaign status if necessary
    await supabase.from('sms_campaigns').update({ status: 'active' }).eq('campaign_id', campaign_id);

    return NextResponse.json({ success: true, queued_count: queueRows.length });
  } catch (err) {
    console.error('Queue batch error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
