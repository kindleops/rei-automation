/**
 * Provider webhook → canonical ledger. Provider-neutral: the adapter
 * normalizes, this records + applies consequences. Replay-safe (event keys
 * derive from provider identity), and events for messages we cannot match are
 * still kept (by recipient) so nothing the provider tells us is lost.
 */
import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { providerFor } from './email-providers.js'
import { recordEmailEvent, applyEventConsequences } from './email-telemetry.js'

export async function ingestProviderEvents(providerName, payloads = [], deps = {}) {
  const db = deps.supabase || defaultSupabase
  const provider = providerFor(providerName)
  if (!provider) return { ok: false, code: 'unknown_provider' }
  const summary = { received: payloads.length, recorded: 0, duplicates: 0, ignored: 0, unmatched: 0, consequences: [] }
  const byMsgId = new Map()
  for (const p of payloads) {
    const ev = provider.normalizeEvent(p)
    if (!ev) { summary.ignored++; continue }
    let message = null
    if (ev.providerMessageId) {
      if (!byMsgId.has(ev.providerMessageId)) {
        const { data } = await db.from('email_queue').select('*').eq('provider_message_id', ev.providerMessageId).maybeSingle()
        byMsgId.set(ev.providerMessageId, data || null)
      }
      message = byMsgId.get(ev.providerMessageId)
    }
    if (!message) summary.unmatched++
    const r = await recordEmailEvent(db, {
      type: ev.type, source: ev.source, message, at: ev.at, key: `${ev.provider}:${ev.providerEventId}`,
      provider: ev.provider, providerEventId: ev.providerEventId, providerMessageId: ev.providerMessageId,
      signalClass: ev.signalClass, bounceClass: ev.bounceClass, reason: ev.reason, raw: ev.raw,
      extra: message ? {} : { recipient_email: ev.recipient, to_email: ev.recipient },
    })
    if (!r.recorded) { summary.duplicates++; continue }
    summary.recorded++
    const c = await applyEventConsequences(db, { ...ev, recipient: ev.recipient }, message, { now: deps.now ? deps.now() : Date.now() })
    if (c.length) summary.consequences.push({ type: ev.type, recipient: ev.recipient, actions: c })
  }
  await db.from('system_control').upsert({ key: `email_webhook_${providerName}_last_event_at`, value: new Date().toISOString() }, { onConflict: 'key' })
  return { ok: true, ...summary }
}
