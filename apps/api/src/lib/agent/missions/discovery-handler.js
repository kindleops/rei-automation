// Runtime handler `acquisition.discovery` — autonomous discovery, one bounded batch
// per scheduled slot (schedule 'acquisition-discovery', born DISABLED).
//
//   1 scan      next ≤ scan_limit properties of the current eg_property_facts build
//               after the watermark cursor (discovery-source.js) + their contact
//               rows, probate audit and campaign membership; the deterministic
//               screen (discovery-screen.js) — suppressed / deceased-only / prior
//               touch / unverified contact / no credible evidence are excluded
//               BEFORE any model call; properties surfaced by a discovery finding in
//               the last 30 days are skipped. $0.
//   2 rank      one Haiku call over the screened top N (model-safe cards: handles,
//               no ids / names / addresses / protected fields), job-owned reserve.
//   3 findings  one discovery.candidate finding per ranked candidate, each with its
//               evidence (source table, column, value) and screening verdicts, plus
//               one discovery.batch summary.
//   4 draft     campaigns.create_draft (a NEW draft; never active; no targets built)
//               pinned to the candidates, then campaigns.prepare_launch_approval →
//               a PENDING approval. Nothing launches; no existing campaign or its
//               membership is read for writing or changed.
//   5 watermark the cursor advances only after the batch is fully recorded.
// A resumed attempt skips every step its checkpoint marks done (no re-spend).
import { RuntimePermanentError } from '../runtime/runtime-tick.js'
import { DISCOVERY_KIND, missionIdentity } from './mission-kinds.js'
import { screenProperty, rankingCard, SCREEN_REASONS } from './discovery-screen.js'
import { encodePropertyRef, decodePropertyRef, jsonBytes } from './mission-codec.js'
import { jobModelCall, parseJsonObject } from './mission-model.js'
import { recordFindings } from './research-mission-handler.js'
import { DEFAULT_ORG_ID } from '../capabilities/index.js'
import { createSession } from '../capabilities/registry.js'

export const WHY_CODES = Object.freeze(['tax_delinquent', 'preforeclosure', 'default_or_lis_pendens', 'liens', 'probate_living_heir', 'high_known_equity', 'long_tenure', 'multiple_signals', 'weak_evidence', 'strong_acquisition_score'])
const RANK_SYSTEM = [
  'You rank pre-screened off-market property candidates for a real-estate acquisitions operator. Every candidate already passed deterministic screening (verified contact, not suppressed, never contacted, credible distress or equity evidence).',
  'Score each candidate 0-100 for how strong an acquisition lead its EVIDENCE is. Use only the fields given. Never use or infer protected characteristics.',
  `Reply with JSON only: {"ranking":[{"c":"C1","score":0,"why":["code"]}]} — why codes from: ${WHY_CODES.join(', ')}.`,
].join('\n')
const SURFACED_DAYS = 30
const CP_MAX = 14_500

export function parseRanking(text, handles) {
  const p = parseJsonObject(text)
  let rows = Array.isArray(p?.ranking) ? p.ranking : null
  if (!rows) {
    // a truncated reply (max_tokens): keep every complete {"c": …} entry
    rows = []
    for (const m of String(text || '').matchAll(/\{[^{}]*"c"\s*:\s*"C[0-9]+"[^{}]*\}/g)) { try { rows.push(JSON.parse(m[0])) } catch { /* partial */ } }
  }
  const out = new Map()
  for (const r of rows) {
    const h = String(r?.c || '')
    if (!handles.has(h) || out.has(h)) continue
    const s = Number(r?.score)
    out.set(h, { model_score: Number.isFinite(s) ? Math.min(Math.max(Math.round(s), 0), 100) : null, why: (Array.isArray(r?.why) ? r.why : []).map(String).filter((w) => WHY_CODES.includes(w)).slice(0, 5) })
  }
  return out
}

/**
 * @param {{ source: object, reads: object, getPlane?: () => Promise<object|null>, provider?: object|null, resolver?: object|null, env?: object, now?: () => number, org_id?: string }} deps
 */
export function createDiscoveryHandler({ source, reads, getPlane = async () => null, provider = null, resolver = null, env = process.env, now = () => Date.now(), org_id = DEFAULT_ORG_ID } = {}) {
  if (!source || !reads) throw new Error('acquisition.discovery: source and reads are required')
  return Object.freeze({
    kind: DISCOVERY_KIND,
    async run(ctx) {
      const input = ctx.job.input || {}
      const identity = missionIdentity(ctx.job.requested_by)
      if (!identity.verified) throw new RuntimePermanentError('MISSION_PRINCIPAL_INVALID')
      const scanLimit = Math.min(Math.max(Number(input.scan_limit) || 400, 10), 1000)
      const topN = Math.min(Math.max(Number(input.rank_top_n) || 12, 1), 15)
      const wantDraft = input.draft !== false
      const cp = { v: 1, ...(ctx.job.checkpoint || {}) }
      const wm = input.schedule_watermark || {}

      // 1 scan + deterministic screen ($0)
      if (!cp.scan) {
        await ctx.step('scan', { progress: { step: 'scan', steps_done: 0, steps_total: 5, pct: 2 }, checkpoint: cp })
        const generation = await source.generation()
        const sameBuild = generation && wm.generation === generation
        if (sameBuild && wm.pass_done) {
          cp.scan = { generation, idle: true, scanned: 0, after: wm.after || null, next_after: wm.after || null, pass_done: true, excluded: {}, screened: 0, candidates: [] }
        } else {
          const after = sameBuild && wm.after ? decodePropertyRef(wm.after) : ''
          const facts = await source.scan({ after, limit: scanLimit })
          const ids = facts.map((f) => String(f.property_id))
          const [contacts, probate, members] = ids.length ? await Promise.all([source.contacts(ids), source.probate(ids), source.campaignMembers(ids)]) : [[], [], new Set()]
          const byProp = new Map()
          for (const c of contacts) { const k = String(c.property_id); if (!byProp.has(k)) byProp.set(k, []); byProp.get(k).push(c) }
          const prob = new Map(probate.map((p) => [String(p.property_id), p]))
          const excluded = Object.fromEntries(SCREEN_REASONS.map((r) => [r, 0]))
          let passed = []
          for (const f of facts) {
            const id = String(f.property_id)
            const s = screenProperty(f, byProp.get(id) || [], prob.get(id) || null, members.has(id))
            if (!s.pass) { for (const r of s.reasons) excluded[r] += 1; continue }
            passed.push({ id, facts: f, ...s })
          }
          const since = new Date(now() - SURFACED_DAYS * 86_400_000).toISOString()
          const seen = await reads.recentFindingKeys({ finding_type: 'discovery.candidate', keys: passed.map((p) => `property.${encodePropertyRef(p.id)}`), since })
          const fresh = passed.filter((p) => !seen.has(`property.${encodePropertyRef(p.id)}`))
          excluded.already_surfaced = passed.length - fresh.length
          passed = fresh.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
          const lastId = ids.length ? ids[ids.length - 1] : (after || null)
          cp.scan = {
            generation, idle: false, scanned: facts.length, after: after ? encodePropertyRef(after) : null, next_after: lastId ? encodePropertyRef(lastId) : null, pass_done: facts.length < scanLimit,
            excluded, screened: passed.length,
            candidates: passed.slice(0, topN).map((p) => ({ ref: encodePropertyRef(p.id), score: p.score, signals: p.signals, evidence: p.evidence, screening: p.screening, card: rankingCard(p, 'C0') })),
          }
          while (jsonBytes(cp) > CP_MAX && cp.scan.candidates.length > 1) cp.scan.candidates.pop()
        }
        await ctx.step('scan.done', { progress: { step: 'scan', steps_done: 1, steps_total: 5, pct: 30 }, checkpoint: cp, payload: { scanned: cp.scan.scanned, screened: cp.scan.screened, candidates: cp.scan.candidates.length, idle: cp.scan.idle } })
      }

      // 2 rank (Haiku, top N only; never on an empty or idle batch)
      if (!cp.rank) {
        const cands = cp.scan.candidates
        if (cands.length && provider && resolver) {
          await ctx.step('rank', { progress: { step: 'rank', steps_done: 1, steps_total: 5, pct: 35 }, checkpoint: cp })
          const handles = new Map(cands.map((c, i) => [`C${i + 1}`, c.ref]))
          const cards = cands.map((c, i) => ({ ...c.card, c: `C${i + 1}` }))
          const r = await jobModelCall({ ctx, provider, resolver, reads, env, identity, system: RANK_SYSTEM, messages: [{ role: 'user', content: JSON.stringify({ candidates: cards }) }], max_tokens: 2000, purpose: 'default' })
          const ranked = parseRanking(r.text, handles)
          cp.rank = { method: ranked.size ? 'model' : 'deterministic', cost_usd: r.cost_usd, parsed: ranked.size, stop_reason: r.stop_reason, output_tokens: r.usage.output_tokens, by_ref: Object.fromEntries([...ranked.entries()].map(([h, v]) => [handles.get(h), v])) }
        } else {
          cp.rank = { method: cands.length ? 'deterministic' : 'none', cost_usd: 0, parsed: 0, by_ref: {} }
        }
        await ctx.step('rank.done', { progress: { step: 'rank', steps_done: 2, steps_total: 5, pct: 55 }, checkpoint: cp, payload: { method: cp.rank.method, parsed: cp.rank.parsed, cost_usd: cp.rank.cost_usd } })
      }

      // order: model score (when present) then deterministic score
      const ordered = cp.scan.candidates.map((c) => ({ ...c, model_score: cp.rank.by_ref[c.ref]?.model_score ?? null, why: cp.rank.by_ref[c.ref]?.why || [] }))
        .sort((a, b) => (b.model_score ?? -1) - (a.model_score ?? -1) || b.score - a.score)

      // 3 findings (evidence on every candidate)
      if (!cp.findings) {
        await ctx.step('findings', { progress: { step: 'findings', steps_done: 2, steps_total: 5, pct: 60 }, checkpoint: cp })
        const fs = ordered.map((c, i) => ({
          finding_type: 'discovery.candidate', key: `property.${c.ref}`, source_id: 'public.eg_property_facts', citation: `eg_property_facts:${c.ref}`,
          value: { property_ref: c.ref, rank: i + 1, deterministic_score: c.score, model_score: c.model_score, why: c.why, signals: c.signals, evidence: c.evidence, screening: c.screening, generation: cp.scan.generation },
          confidence: c.model_score == null ? 0.6 : Math.min(0.95, 0.5 + c.model_score / 250),
        }))
        fs.push({ finding_type: 'discovery.batch', key: 'batch', source_id: 'agent.discovery', value: { generation: cp.scan.generation, idle: cp.scan.idle, scanned: cp.scan.scanned, screened: cp.scan.screened, candidates: ordered.length, excluded: cp.scan.excluded, cursor_after: cp.scan.next_after, pass_done: cp.scan.pass_done, rank_method: cp.rank.method, rank_cost_usd: cp.rank.cost_usd }, confidence: 1 })
        cp.findings = await recordFindings(ctx, fs)
        await ctx.step('findings.done', { progress: { step: 'findings', steps_done: 3, steps_total: 5, pct: 75 }, checkpoint: cp, payload: { written: cp.findings.written } })
      }

      // 4 draft + pending launch approval (never launched)
      if (!cp.draft) {
        if (!wantDraft || !ordered.length) {
          cp.draft = { status: ordered.length ? 'skipped_by_input' : 'no_candidates' }
        } else {
          await ctx.step('draft', { progress: { step: 'draft', steps_done: 3, steps_total: 5, pct: 80 }, checkpoint: cp })
          const plane = await getPlane().catch(() => null)
          if (!plane) {
            cp.draft = { status: 'skipped', code: 'CAPABILITIES_UNAVAILABLE' }
          } else {
            const ids = ordered.map((c) => decodePropertyRef(c.ref))
            const day = new Date(now()).toISOString().slice(0, 10)
            const ictx = { org_id, identity, source: 'model', session: createSession() }
            const d = await plane.invoker.invoke({ capability_id: 'campaigns.create_draft', input: { name: `Discovery ${day} · ${ids.length} candidates`, template_use_case: 'ownership_check', filters: { properties: [{ field_key: 'property_id', operator: 'is_any_of', values: ids }] }, campaign_size: 'custom', total_cap: ids.length }, ctx: ictx })
            if (!d.ok) {
              cp.draft = { status: 'refused', code: String(d.code || 'REFUSED').slice(0, 60) }
            } else {
              const campaign_id = d.result?.campaign_id
              const a = await plane.invoker.invoke({ capability_id: 'campaigns.prepare_launch_approval', input: { campaign_id, start: 'now', expected_eligible: ids.length }, ctx: ictx })
              cp.draft = { status: d.result?.status || 'draft', campaign_id, replayed: d.status === 'replayed', approval: a.ok ? { approval_id: a.approval_id, expires_at: a.expires_at || null, state: 'pending' } : { refused: String(a.code || 'REFUSED').slice(0, 60) } }
            }
          }
          await ctx.recordFinding({ finding_type: 'discovery.draft', key: 'draft', source_id: 'public.campaigns', value: cp.draft, confidence: 1 }).catch(() => null)
        }
        await ctx.step('draft.done', { progress: { step: 'draft', steps_done: 4, steps_total: 5, pct: 90 }, checkpoint: cp, payload: { status: cp.draft.status } })
      }

      // 5 watermark (only now: a crash before this re-scans the same slice, never skips it)
      if (!cp.watermarked) {
        if (ctx.job.schedule_id != null) await ctx.setWatermark({ generation: cp.scan.generation, after: cp.scan.next_after, pass_done: cp.scan.pass_done, last_job_id: ctx.job.job_id })
        cp.watermarked = true
        await ctx.step('watermark', { progress: { step: 'watermark', steps_done: 5, steps_total: 5, pct: 99 }, checkpoint: cp, payload: { pass_done: cp.scan.pass_done } })
      }

      return { result: { mission: 'discovery', generation: cp.scan.generation, idle: cp.scan.idle, scanned: cp.scan.scanned, screened: cp.scan.screened, excluded: cp.scan.excluded, candidates: ordered.map((c, i) => ({ property_ref: c.ref, rank: i + 1, deterministic_score: c.score, model_score: c.model_score })), rank_method: cp.rank.method, cost_usd: (await reads.jobSpend(ctx.job.job_id)).committed_usd, findings: cp.findings.written, draft: cp.draft, cursor_after: cp.scan.next_after, pass_done: cp.scan.pass_done } }
    },
  })
}
