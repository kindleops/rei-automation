import { NextResponse } from 'next/server'
import { withCors, handleOptionsResponse } from '../../_shared.js'
import { supabase } from '../../../../../lib/supabase/client.js'
import { resolveInboxThreadState } from '../../../../../lib/domain/inbox/resolveInboxThreadState.js'

export async function GET(request) {
  try {
    const { data: threads, error } = await supabase
      .from('inbox_threads_hydrated')
      .select('*')

    if (error) {
      return withCors(request, NextResponse.json({ error: error.message }, { status: 500 }))
    }

    const debugResults = threads.map(thread => {
      const state = resolveInboxThreadState(thread)
      return {
        threadId: thread.id,
        threadKey: thread.thread_key,
        ownerName: thread.owner_display_name || thread.prospect_full_name,
        latestMessage: thread.latest_message_body,
        direction: thread.latest_direction,
        isArchived: thread.is_archived,
        isUnread: !thread.is_read || thread.unread_count > 0,
        bucket: state.bucket,
        reasons: state.reasons
      }
    })

    const counts = {
      all: 0,
      new_replies: 0,
      priority: 0,
      follow_up: 0,
      negotiating: 0,
      waiting_on_seller: 0,
      automated: 0,
      needs_review: 0,
      suppressed: 0,
      cold: 0
    }

    debugResults.forEach(r => {
      if (counts[r.bucket] !== undefined) {
        counts[r.bucket]++
      }
      counts.all++
    })

    return withCors(request, NextResponse.json({ counts, threads: debugResults }))
  } catch (err) {
    return withCors(request, NextResponse.json({ error: err.message }, { status: 500 }))
  }
}

export async function OPTIONS(request) {
  return handleOptionsResponse(request);
}
