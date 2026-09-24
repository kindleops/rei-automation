/**
 * A campaign's activity, without the scheduler's heartbeat drowning it out.
 *
 * The scheduler records a "Campaign launch planned" event every few minutes,
 * and an idle one says "0 targets planned; 0 queue rows created." — 27,867 of
 * them in production. The detail endpoint returns the latest 100 events, and
 * for Miami 99 of those 100 were that tick: its activation, its switch to live
 * and every block had fallen out of the window.
 *
 * So: every other event first, then only the most recent planning ticks, and a
 * count of how many ticks there have been. Read-only.
 */

import { supabase as defaultSupabase } from '@/lib/supabase/client.js'

const PLANNING_EVENT = 'campaign.launch_scheduled'
const DEFAULT_LIMIT = 100
const PLANNING_TICKS = 20

export async function fetchCampaignActivity(campaignId, options = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  if (!campaignId) return { ok: false, error: 'campaign_id_required' }
  const limit = Math.max(1, Math.min(200, Math.floor(Number(options.limit) || DEFAULT_LIMIT)))

  const [others, planning, planningCount] = await Promise.all([
    supabase
      .from('campaign_events')
      .select('id,campaign_id,event_type,severity,title,description,created_at')
      .eq('campaign_id', campaignId)
      .neq('event_type', PLANNING_EVENT)
      .order('created_at', { ascending: false })
      .limit(limit),
    supabase
      .from('campaign_events')
      .select('id,campaign_id,event_type,severity,title,description,created_at')
      .eq('campaign_id', campaignId)
      .eq('event_type', PLANNING_EVENT)
      .order('created_at', { ascending: false })
      .limit(PLANNING_TICKS),
    supabase
      .from('campaign_events')
      .select('id', { count: 'exact', head: true })
      .eq('campaign_id', campaignId)
      .eq('event_type', PLANNING_EVENT),
  ])
  if (others.error) throw others.error
  if (planning.error) throw planning.error

  const events = [...(others.data || []), ...(planning.data || [])]
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .slice(0, limit)

  return {
    ok: true,
    campaign_id: campaignId,
    events,
    planning_ticks: {
      total: planningCount.error ? null : Number(planningCount.count || 0),
      shown: (planning.data || []).length,
    },
  }
}
