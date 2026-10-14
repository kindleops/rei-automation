// One bounded model call owned by a runtime job (supervisor split / consolidation,
// discovery ranking). Same gates and money rules as the research ask:
//   AGENT_ENABLED → AGENT_RESEARCH_ENABLED → AGENT_MAX_MODE=read → named principal →
//   resolved, priced default-route (Haiku-line) model → prompt inside a priced tier →
//   nothing contact-shaped in the prompt (pii.js residual check) → code caps (env ∧ DB)
//   → job-owned reserve (agent.runtime_reserve; spend_ledger_guard decides; a refusal
//   parks the job budget_blocked) → provider call, no tools, no retries → settle the
//   provider-reported usage × price table (outside every tier ⇒ settle at the reserve).
// The provider is injected (lib/agent never imports a provider SDK).
import { isAgentEnabled } from '../config/agent-config.js'
import { round6 } from '../budget/budget-config.js'
import { worstCaseUsd, actualUsd, maxPricedPrompt } from '../research/models.js'
import { isResearchEnabled, researchModeOk, resolveResearchCaps, effectiveCaps, checkBudget } from '../research/research-config.js'
import { residualContact } from '../research/pii.js'
import { RuntimePermanentError, RuntimeStop } from '../runtime/runtime-tick.js'

const bytes = (v) => Buffer.byteLength(typeof v === 'string' ? v : JSON.stringify(v), 'utf8')
const joinText = (content = []) => content.filter((b) => b?.type === 'text').map((b) => b.text).join('').trim()

/**
 * @param {{ ctx: object, provider: { createMessage: Function }, resolver: { resolve: Function }, reads: object, env?: object, identity: object,
 *           system: string, messages: Array<object>, max_tokens: number, purpose: string, knownIds?: Set<string>, timeoutMs?: number }} o
 * @returns {Promise<{ text: string, cost_usd: number, model: string, usage: object, stop_reason: string }>}
 */
export async function jobModelCall({ ctx, provider, resolver, reads, env = process.env, identity, system, messages, max_tokens, purpose, knownIds = null, timeoutMs = 30_000, effort = 'low' }) {
  if (!isAgentEnabled(env)) throw new RuntimePermanentError('AGENT_DISABLED')
  if (!isResearchEnabled(env)) throw new RuntimePermanentError('RESEARCH_DISABLED')
  if (!researchModeOk(env)) throw new RuntimePermanentError('MODE_NOT_READ')
  if (!(identity?.verified === true && identity?.named === true && identity?.user_id)) throw new RuntimePermanentError('IDENTITY_REQUIRED')
  const models = await resolver.resolve()
  const model = models?.default
  if (!model?.id) throw new RuntimePermanentError('MODEL_UNRESOLVED')
  // effort 'low' where supported (as the research ask does): adaptive thinking otherwise eats the output budget
  const body = { model: model.id, max_tokens, system, messages, ...(model.supports_effort && effort ? { output_config: { effort } } : {}) }
  const bound = bytes({ system, messages })
  if (bound > maxPricedPrompt(model.id)) throw new RuntimePermanentError('PROMPT_TOO_LARGE')
  const worst = worstCaseUsd(model.id, { promptTokensBound: bound, maxTokens: max_tokens })
  if (worst == null) throw new RuntimePermanentError('UNPRICED_MODEL')
  if (residualContact(JSON.stringify(messages), { knownIds })) throw new RuntimePermanentError('PII_RESIDUAL')
  const [dbLimits, totals, job] = await Promise.all([reads.researchLimits(), reads.spendTotals(), reads.jobSpend(ctx.job.job_id)])
  const caps = effectiveCaps(resolveResearchCaps(env), dbLimits)
  const budget = checkBudget({ caps, totals: { day_usd: totals.day_usd, cycle_usd: totals.cycle_usd, run_usd: job.committed_usd, run_escalation_usd: 0, run_escalation_calls: 0 }, worst_usd: worst, purpose: 'default' })
  if (!budget.ok) throw new RuntimePermanentError(budget.code)
  const reserve_id = await ctx.reserve(model.id, Math.max(round6(worst), 0.000001), purpose) // RuntimeStop('budget_blocked') on refusal
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort({ code: 'MODEL_TIMEOUT' }), timeoutMs)
  if (typeof t.unref === 'function') t.unref()
  const onAbort = () => ac.abort({ code: 'CANCELLED' })
  ctx.signal?.addEventListener?.('abort', onAbort, { once: true })
  let message
  try {
    message = await provider.createMessage(body, { signal: ac.signal })
  } catch (err) {
    // billed 'no' ⇒ release; anything else stays reserved (runtime_finish marks it unknown, still counted)
    if (err?.billed === 'no') await ctx.settle(reserve_id, null, null).catch(() => {})
    if (ctx.signal?.aborted) throw new RuntimeStop('deadline')
    throw Object.assign(new Error('MODEL_CALL_FAILED'), { code: String(err?.code || 'PROVIDER_ERROR').replace(/[^A-Z0-9_]/gi, '_').slice(0, 60) })
  } finally {
    clearTimeout(t)
    ctx.signal?.removeEventListener?.('abort', onAbort)
  }
  const usage = message?.usage || {}
  const priced = actualUsd(model.id, usage)
  const cost = priced ? priced.usd : round6(worst)
  await ctx.settle(reserve_id, cost, { input_tokens: Number(usage.input_tokens || 0), output_tokens: Number(usage.output_tokens || 0), cache_read_input_tokens: Number(usage.cache_read_input_tokens || 0) })
  return { text: joinText(message?.content), cost_usd: cost, model: model.id, usage: { input_tokens: Number(usage.input_tokens || 0), output_tokens: Number(usage.output_tokens || 0) }, stop_reason: String(message?.stop_reason || 'unknown').slice(0, 40) }
}

/** First JSON object in a model's text (fenced or bare); null when none parses. */
export function parseJsonObject(text) {
  const s = String(text || '')
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(s)
  const cands = [fenced?.[1], s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)].filter(Boolean)
  for (const c of cands) {
    try { const v = JSON.parse(c); if (v && typeof v === 'object') return v } catch { /* next */ }
  }
  return null
}
