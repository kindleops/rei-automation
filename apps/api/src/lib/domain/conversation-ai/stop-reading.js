// ONE STOP READING for the canonical turn pipeline (rc-8.5.21 v4, S2 / S3). Pure.
//
// Owner rule: STOP is absolute, and a request to stop contacting is an opt-out in every language.
// The v4 qualification found the other half of that rule missing: a stop-like reading that the
// deterministic grammar did NOT confirm (the model understood intent=opt_out; the classifier saw a
// possible opt-out token; the word "stop" appears; an uncertain stop-like word in a language we do not
// converse in) ended as "hold for review", "escalate language_not_enabled" or even a composed close —
// with no contact-wide hold, so every other automated path (follow-ups, campaigns) stayed open.
//
// Every layer's stop reading is combined here, and there are only two outcomes:
//   confirmed  the deterministic grammar / classifier recognised a revocation → SUPPRESS (opt-out)
//   uncertain  any other stop-like reading → SUPPRESS in PRECAUTIONARY mode: the contact-wide
//              precautionary_no_contact hold (record-precautionary-hold.js), nothing sent, a person decides
// Never "unclear and contactable", never a reply.
import { matchMultilingualOptOut } from '../classification/multilingual-opt-out.js'
import { analyzeContactRevocation, isChannelPreferenceOnly } from '../classification/multilingual-contact-revocation.js'
import { classifyStopScope, STOP_SCOPE } from '../classification/stop-scope.js'
import { isStopRequest } from './stop-request.js'
import { deterministicPrecheck } from './precheck.js'

export const STOP_READING_VERSION = 'conv-ai.stop-reading.v1'
const SUPPRESS_INTENTS = new Set(['opt_out', 'stop_texting', 'unsubscribe', 'do_not_contact'])
const BARE_STOP_RE = /^\s*(?:stop|stopall|stop\s*all|unsubscribe|cancel|end|quit|remove\s+me|opt\s*out)\s*[.!]*\s*$/i

/**
 * @param {{ text: string, deterministic?: { intent?: string|null, compliance_flag?: string|null, possible_opt_out?: object|null }|null, judgment?: { intent?: string|null, facts_extracted?: Array, escalation_reason?: string|null }|null }} a
 * @returns {{ confirmed: boolean, uncertain: boolean, sources: string[], evidence: object|null, version: string }}
 */
export function readStop({ text = '', deterministic = null, judgment = null } = {}) {
  const body = String(text ?? '')
  const sources = []
  let evidence = null
  const channelOnly = isChannelPreferenceOnly(body)
  const grammar = channelOnly ? null : matchMultilingualOptOut(body)
  const revocation = analyzeContactRevocation(body)
  const otherAction = classifyStopScope(body) === STOP_SCOPE.OTHER_ACTION
  // ── confirmed: the deterministic grammar or the classifier
  if (grammar) { sources.push(`grammar:${grammar.rule_id}`); evidence = { rule_id: grammar.rule_id, language: grammar.language, version: grammar.version } }
  if (!channelOnly && BARE_STOP_RE.test(body)) sources.push('bare_stop_keyword')
  if (SUPPRESS_INTENTS.has(String(deterministic?.intent || '')) || deterministic?.compliance_flag === 'stop_texting') sources.push(`classifier:${deterministic?.intent || deterministic?.compliance_flag}`)
  // the deterministic pre-check's own stop rule (a stop verb aimed at communication: "don't text me")
  const pre = deterministicPrecheck({ text: body, inboundId: 'stop-reading', deterministic: deterministic ? { intent: deterministic.intent ?? null, compliance_flag: deterministic.compliance_flag ?? null } : null })
  if (pre.decided && pre.decision?.outcome === 'SUPPRESS' && /^(?:stop_or_opt_out|classifier_)/.test(String(pre.reason || ''))) sources.push(`precheck:${pre.reason}`)
  const confirmed = sources.length > 0
  if (confirmed) return { confirmed: true, uncertain: false, sources, evidence, version: STOP_READING_VERSION }
  // ── uncertain: every other stop-like reading
  if (revocation.possible_opt_out && !otherAction) { sources.push(`possible_opt_out:${revocation.possible_opt_out.rule_id}`); evidence = { rule_id: revocation.possible_opt_out.rule_id, language: revocation.possible_opt_out.language, token: revocation.possible_opt_out.token, version: revocation.possible_opt_out.version } }
  if (deterministic?.possible_opt_out) sources.push('classifier:possible_opt_out')
  if (!channelOnly && isStopRequest(body)) sources.push('stop_word')
  const j = judgment || null
  if (j && (SUPPRESS_INTENTS.has(String(j.intent || '')) || (j.facts_extracted || []).some((f) => /opt_?out|stop/i.test(String(f?.fact || '')) && !/^(?:false|no|none)$/i.test(String(f?.value ?? ''))) || /opt_?out|stop_request/i.test(String(j.escalation_reason || '')))) sources.push(`understanding:${j.intent || 'opt_out'}`)
  if (sources.length && !evidence) evidence = { rule_id: sources[0], language: revocation.possible_opt_out?.language || null, token: null, version: STOP_READING_VERSION }
  return { confirmed: false, uncertain: sources.length > 0, sources, evidence, version: STOP_READING_VERSION }
}
