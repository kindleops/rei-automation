import { useState, useEffect, useRef, useCallback } from 'react';
import { getSupabaseClient } from '../../../lib/supabaseClient';
import type { NexusCoreState, OrbActivityMetrics } from '../types/orb';

const DECAY_RATE = 0.95; // Multiply heat by this every tick
const TICK_INTERVAL = 2000; // 2 seconds

export function useNexusActivity() {
  const [metrics, setMetrics] = useState<OrbActivityMetrics>({
    queueSendsPerMin: 0,
    repliesPerMin: 0,
    classificationsPerMin: 0,
    activeUnderwritingJobs: 0,
    hotLeadCount: 0,
    automationExecutionCount: 0,
    heatIndex: 0,
  });

  const [activeState, setActiveState] = useState<NexusCoreState>('idle');
  const activityCounts = useRef({
    sends: 0,
    replies: 0,
    classifications: 0,
    underwriting: 0,
    hotLeads: 0,
    automations: 0,
  });

  const heatRef = useRef(0);
  const supabase = getSupabaseClient();

  const bumpHeat = useCallback((amount: number, state: NexusCoreState) => {
    heatRef.current = Math.min(1.0, heatRef.current + amount);
    setActiveState(state);
    
    // Reset to idle after a duration if it was a pulse state
    if (state !== 'idle' && state !== 'hot_lead' && state !== 'critical') {
      setTimeout(() => {
        setActiveState('idle');
      }, 3000);
    }
  }, []);

  useEffect(() => {
    // 1. Subscribe to Outbound Activity
    const queueSub = supabase
      .channel('orb-queue-activity')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'send_queue' },
        () => {
          activityCounts.current.sends++;
          bumpHeat(0.1, 'sending');
        }
      )
      .subscribe();

    // 2. Subscribe to Inbound Activity (Replies)
    const replySub = supabase
      .channel('orb-reply-activity')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'message_events' },
        (payload) => {
          if (payload.new.direction === 'inbound') {
            activityCounts.current.replies++;
            bumpHeat(0.3, 'reply');
          }
        }
      )
      .subscribe();

    // 3. Subscribe to AI Activity (Classifications & Underwriting)
    const aiSub = supabase
      .channel('orb-ai-activity')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'thread_ai_state' },
        (payload) => {
          const { deal_temperature, processing_state } = payload.new;
          const oldState = payload.old.processing_state;

          if (deal_temperature === 'hot' && payload.old.deal_temperature !== 'hot') {
            activityCounts.current.hotLeads++;
            bumpHeat(0.5, 'hot_lead');
          }

          if (processing_state === 'classifying' && oldState !== 'classifying') {
            activityCounts.current.classifications++;
            bumpHeat(0.2, 'classify');
          } else if (processing_state === 'underwriting' && oldState !== 'underwriting') {
            activityCounts.current.underwriting++;
            bumpHeat(0.25, 'underwriting');
          }
        }
      )
      .subscribe();

    // 4. Tick logic for decay and metrics aggregation
    const interval = setInterval(async () => {
      heatRef.current *= DECAY_RATE;
      
      // Periodically refresh hot lead count from DB
      try {
        const { count } = await supabase
          .from('thread_ai_state')
          .select('*', { count: 'exact', head: true })
          .eq('deal_temperature', 'hot');
        
        if (count !== null) {
          activityCounts.current.hotLeads = count;
        }
      } catch (err) {
        console.error('Failed to fetch hot lead count', err);
      }
      
      setMetrics({
        queueSendsPerMin: activityCounts.current.sends * 30,
        repliesPerMin: activityCounts.current.replies * 30,
        classificationsPerMin: activityCounts.current.classifications * 30,
        activeUnderwritingJobs: activityCounts.current.underwriting,
        hotLeadCount: activityCounts.current.hotLeads,
        automationExecutionCount: activityCounts.current.automations,
        heatIndex: heatRef.current,
      });
    }, TICK_INTERVAL);

    return () => {
      supabase.removeChannel(queueSub);
      supabase.removeChannel(replySub);
      supabase.removeChannel(aiSub);
      clearInterval(interval);
    };
  }, [supabase, bumpHeat]);

  return { metrics, activeState, heat: heatRef.current };
}
