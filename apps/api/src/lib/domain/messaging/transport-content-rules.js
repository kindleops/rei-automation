// THE TRANSPORT'S OWN CONTENT RULES, in ONE place. The TextGrid client (providers/textgrid.js#sendTextgridSMS) and the
// queue runner (queue/process-send-queue.js, the blank-greeting guard before the provider call) refuse a body by these
// exact patterns; the Action Gateway's agent-text validator applies the SAME patterns at request time, so an agent's
// text can never pass the gateway and then be refused at transport. Pure.

// TextGrid client (case-INSENSITIVE, anywhere): a greeting word directly followed by a comma — "Hi," / "hey ," / a
// mid-text "hi," — reads as a greeting whose name did not render ("Hello ,").
export const TEXTGRID_BLANK_GREETING_RE = /^(Hello|Hi|Hey|Hola|Ola|Marhaba)\s*,|(Hello\s*,|Hey\s*,|Hi\s*,|Hola\s*,|Ola\s*,|Marhaba\s*,)/i
/**
 * Both placeholder shapes, because the renderer REWRITES one into the other: templates are authored with {{variable}};
 * an unresolved variable is rendered as `[[variable]]` (a deliberately visible marker). Either one never reaches the wire.
 */
export const TEXTGRID_UNRESOLVED_PLACEHOLDER_RE = /\{\{[^}]+\}\}|\[\[[^\]]+\]\]/
// The queue runner's belt-and-suspenders guard (a body that STARTS with a blank greeting, any case; or a capitalized
// greeting + comma anywhere).
export const RUNNER_BLANK_GREETING_GUARD_RE = /^(hi|hey|hello|hola|ola|marhaba)\s*,/i
export const RUNNER_BLANK_GREETING_INLINE_RE = /(Hello\s*,|Hey\s*,|Hi\s*,|Hola\s*,|Ola\s*,|Marhaba\s*,)/

/**
 * The PROFILE of a body decides which rules the transport applies:
 *   'rendered'    (default) a body produced by rendering a template / merge fields: every rule — the blank-greeting
 *                 patterns exist to catch "Hi {{seller_first_name}}," rendered with no name ("Hi ,", "Hello ,").
 *   'agent_text'  the EXACT words an Agntei AI employee composed (queue_agent_text), verified at dispatch against its
 *                 immutable ledger record: nothing was rendered, so a greeting followed by a comma ("Hi, this is Nova")
 *                 is ordinary writing, not a missing name; the placeholder rule and the empty-body rule still apply.
 * The queue runner and the TextGrid client apply the agent_text profile ONLY to a row whose body the agent-text row
 * gate verified against its ledger record; the agent-text validator applies the same profile at request time.
 */
export const TRANSPORT_PROFILES = Object.freeze(['rendered', 'agent_text'])
export const appliesBlankGreetingRule = (profile = 'rendered') => profile !== 'agent_text'

/** The transport's refusal reasons for a body (the trimmed text the client would send); [] = the transport accepts it. */
export function transportContentReasons(body, { profile = 'rendered' } = {}) {
  const t = String(body ?? '').trim()
  const r = []
  if (!t) r.push('transport:empty_message_body')
  if (appliesBlankGreetingRule(profile) && (TEXTGRID_BLANK_GREETING_RE.test(t) || RUNNER_BLANK_GREETING_GUARD_RE.test(t) || RUNNER_BLANK_GREETING_INLINE_RE.test(t))) r.push('transport:blank_greeting_pattern')
  if (TEXTGRID_UNRESOLVED_PLACEHOLDER_RE.test(t)) r.push('transport:unresolved_placeholder')
  return r
}
