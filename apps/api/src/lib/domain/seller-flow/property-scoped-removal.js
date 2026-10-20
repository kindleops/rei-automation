// ─── property-scoped-removal.js ──────────────────────────────────────────────
// rc-8.5.21 v3 (owner rule): "Take me off that one" with an IDENTIFIABLE property is a PROPERTY-SCOPED
// do-not-contact for that property × contact. It is NOT evidence of non-ownership (never a denial, never
// a wrong number) and NOT a contact-wide opt-out. Everything else stays exactly as the classifier says:
//   • no identifiable property (none, several, an address that is not one of the thread's) ⇒ the
//     contact-wide opt-out stands (STOP stays absolute when in doubt);
//   • any contact-wide wording (stop, list, all, everything, texting / messages / number, unsubscribe,
//     "anymore", "ever") ⇒ the contact-wide opt-out stands.
// The detector and resolver are pure; recordPropertyDoNotContact persists. The persistence is contact_property_resolution role property_do_not_contact (the recontact guard,
// the follow-up lifecycle, the canonical writer and the campaign opener exclusion all read it).

export const PROPERTY_DNC_ROLE = 'property_do_not_contact'
const clean = (v) => String(v ?? '').trim()
const lower = (v) => clean(v).toLowerCase()

// "take me off that one", "remove me from that property", "take me off for 12 Oak", "don't contact me about that house"
const REMOVAL_RE = /\b(?:take|get|remove|drop|cross|scratch)\s+(?:me|us|my\s+name)\s+(?:off|out|from)\b|\b(?:do\s*n[o']?t|dont|don'?t|no\s+more|stop)\s+(?:contact(?:ing)?|text(?:ing)?|messag(?:e|ing)|ask(?:ing)?)\s+(?:me|us)\s+(?:about|regarding|on|for)\b/i
const DEMONSTRATIVE_RE = /\b(?:that|this|the)\s+(?:one|property|house|home|place|address|lot|building|unit|land)\b/i
// contact-wide wording: the removal is about the CHANNEL, not one property
const CONTACT_WIDE_RE = /\b(?:list|lists|all|everything|every(?:one|thing)?|any(?:more|thing)|ever|again|number|phone|unsubscribe|opt\s*-?\s*out|spam|harass\w*)\b|\bstop\b(?!\s+(?:contact(?:ing)?|text(?:ing)?|messag(?:e|ing)|ask(?:ing)?)\s+(?:me|us)\s+(?:about|regarding|on|for)\b)|\b(?:texts?|texting|messages?|messaging|calls?|calling)\b(?!\s+(?:me|us)\s+(?:about|regarding|on|for)\b)/i

const normAddr = (s) => lower(s).replace(/[.,#]/g, ' ').replace(/\b(street|st|avenue|ave|road|rd|drive|dr|lane|ln|court|ct|boulevard|blvd|place|pl|way)\b/g, '').replace(/\s+/g, ' ').trim()

/** Does the text ask to be removed for ONE property (and only that)? */
export function matchPropertyScopedRemoval(text = '') {
  const t = clean(text)
  if (!t || t.length > 160) return { matched: false }
  if (!REMOVAL_RE.test(t)) return { matched: false }
  const demonstrative = DEMONSTRATIVE_RE.test(t)
  const addressLike = /\b\d{1,6}\s+[a-z][a-z]+/i.test(t)
  if (!demonstrative && !addressLike) return { matched: false }
  // strip the property reference before the contact-wide check ("that one" is not "all")
  const rest = t.replace(DEMONSTRATIVE_RE, ' ').replace(/\b\d{1,6}\s+[a-z][a-z.]*(?:\s+[a-z][a-z.]*){0,3}/gi, ' ')
  if (CONTACT_WIDE_RE.test(rest)) return { matched: false, contact_wide: true }
  return { matched: true, reference: addressLike ? 'address' : 'demonstrative' }
}

/**
 * The property the removal is about, or null (⇒ the contact-wide opt-out stands).
 * @param {{ text: string, propertyId?: string|null, properties?: Array<{ property_id: string, address?: string|null }>, lastOutboundPropertyIds?: string[], ambiguous?: boolean }} a
 */
export function resolvePropertyScopedRemoval({ text = '', propertyId = null, properties = [], lastOutboundPropertyIds = [], ambiguous = false } = {}) {
  const m = matchPropertyScopedRemoval(text)
  if (!m.matched) return { scoped: false, reason: m.contact_wide ? 'contact_wide_wording' : 'not_property_removal' }
  if (ambiguous) return { scoped: false, reason: 'property_ambiguous' }
  const props = (properties || []).filter((p) => clean(p?.property_id))
  if (m.reference === 'address') {
    const t = normAddr(text)
    const hits = props.filter((p) => clean(p.address) && t.includes(normAddr(p.address).split(' ').slice(0, 2).join(' ')))
    return hits.length === 1 ? { scoped: true, property_id: clean(hits[0].property_id), basis: 'address_named' } : { scoped: false, reason: hits.length ? 'address_matches_several' : 'address_not_on_thread' }
  }
  // "that one": the property our LAST outbound was about — exactly one
  const last = [...new Set((lastOutboundPropertyIds || []).map(clean).filter(Boolean))]
  if (last.length === 1) return { scoped: true, property_id: last[0], basis: 'last_outbound_property' }
  if (last.length > 1) return { scoped: false, reason: 'property_ambiguous' }
  const distinct = [...new Set(props.map((p) => clean(p.property_id)))]
  if (distinct.length <= 1 && clean(propertyId) && (!distinct.length || distinct[0] === clean(propertyId))) return { scoped: true, property_id: clean(propertyId), basis: 'single_property_thread' }
  return { scoped: false, reason: 'property_unidentified' }
}

/**
 * PERSIST a property-scoped do-not-contact (the disposition boundary). Writes the property × contact
 * restriction (contact_property_resolution role property_do_not_contact) and re-labels THIS inbound and
 * the thread from the classifier's contact-wide opt_out label to property_do_not_contact — but ONLY when
 * the contact carries no active contact-wide suppression (sms_suppression_list / automation_suppressions):
 * a real opt-out is never relabelled. Any read / write failure ⇒ { ok: false } and the caller applies the
 * contact-wide opt-out instead (fail closed).
 * @returns {Promise<{ ok: boolean, reason?: string, relabelled?: boolean }>}
 */
export async function recordPropertyDoNotContact({ supabase, phone, property_id, thread_key = null, inbound_event_id = null, now = new Date().toISOString() } = {}) {
  if (!supabase?.from || !clean(phone) || !clean(property_id)) return { ok: false, reason: 'property_dnc_input_incomplete' }
  const tail = clean(phone).replace(/\D/g, '').slice(-10)
  const variants = [clean(phone), tail, `1${tail}`, `+1${tail}`]
  try {
    const up = await supabase.from('contact_property_resolution').upsert({
      property_id: clean(property_id), contact_phone_e164: clean(phone), contact_property_role: PROPERTY_DNC_ROLE,
      rejected_at: now, rejection_reason: `seller_requested_property_removal${clean(inbound_event_id) ? `:${clean(inbound_event_id)}` : ''}`, suppression_scope: 'contact_property_pair', updated_at: now,
    }, { onConflict: 'property_id,contact_phone_e164' })
    if (up?.error) return { ok: false, reason: clean(up.error.message) || 'upsert_failed' }
    const [sup, auto] = await Promise.all([
      supabase.from('sms_suppression_list').select('is_active').in('phone_e164', variants).limit(5),
      supabase.from('automation_suppressions').select('status,expires_at').in('phone_e164', variants).limit(5),
    ])
    if (sup?.error || auto?.error) return { ok: false, reason: 'suppression_read_failed' }
    const contactWide = (sup.data || []).some((r) => r.is_active !== false) || (auto.data || []).some((r) => !/released|inactive|lifted|cleared|expired|revoked|resolved|cancel|superseded/.test(lower(r.status)) && !(clean(r.expires_at) && Date.parse(r.expires_at) <= Date.parse(now)))
    if (contactWide) return { ok: true, relabelled: false, reason: 'contact_wide_suppression_present' }
    if (clean(inbound_event_id)) {
      const ev = await supabase.from('message_events').update({ detected_intent: PROPERTY_DNC_ROLE }).eq('id', clean(inbound_event_id)).eq('detected_intent', 'opt_out')
      if (ev?.error) return { ok: false, reason: 'relabel_inbound_failed' }
    }
    if (clean(thread_key)) {
      const th = await supabase.from('inbox_thread_state').update({ disposition: PROPERTY_DNC_ROLE, last_intent: PROPERTY_DNC_ROLE, is_suppressed: false }).eq('thread_key', clean(thread_key)).in('last_intent', ['opt_out', PROPERTY_DNC_ROLE])
      if (th?.error) return { ok: false, reason: 'relabel_thread_failed' }
    }
    return { ok: true, relabelled: true }
  } catch (error) {
    return { ok: false, reason: clean(error?.message) || 'property_dnc_failed' }
  }
}
