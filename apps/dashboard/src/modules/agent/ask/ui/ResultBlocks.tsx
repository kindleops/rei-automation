import { cx } from '../../../../shared/lc'
import type { AskResultEnvelope, ResultBlock, ResultFact, WebCitation } from '../ask-model'
import { AskMarkdown } from '../AskMarkdown'
import { Glyph } from './glyphs'

/**
 * TYPED RESULTS (lc.ask.result v1). Known kinds render as components; anything
 * else falls back to Markdown. Public-web evidence and LeadCommand records are
 * always shown apart — a web citation is never styled like an internal record.
 */
export function ResultBlocks({ result, answerMd, citeIds, onCite, labelOf, onOpen }: {
  result: AskResultEnvelope | null | undefined
  answerMd: string
  citeIds: string[]
  onCite: (id: string) => void
  labelOf: (id: string) => string | null
  onOpen: (href: string) => void
}) {
  const blocks = result?.blocks?.length ? result.blocks : answerMd ? [{ kind: 'answer', markdown: answerMd } as ResultBlock] : []
  return (
    <div className="ak-blocks">
      {blocks.map((b, i) => <Block key={`${b.kind}:${i}`} b={b} citeIds={citeIds} onCite={onCite} labelOf={labelOf} onOpen={onOpen} />)}
    </div>
  )
}

function Block({ b, citeIds, onCite, labelOf, onOpen }: { b: ResultBlock; citeIds: string[]; onCite: (id: string) => void; labelOf: (id: string) => string | null; onOpen: (href: string) => void }) {
  if (b.kind === 'answer') return <PlainAnswer md={String((b as { markdown?: unknown }).markdown ?? '')} citeIds={citeIds} onCite={onCite} labelOf={labelOf} />
  if (b.kind === 'web_citations') return <WebCitations citations={(b as { citations: WebCitation[] }).citations} />
  if (b.kind === 'property_research') return <PropertyResearchCard b={b as Extract<ResultBlock, { kind: 'property_research' }>} onOpen={onOpen} />
  // fallback: a known-but-unrendered or future kind shows as Markdown from its title / summary / points
  const o = b as { title?: unknown; summary?: unknown; points?: unknown; action?: unknown; executed?: unknown }
  const lines = [o.title ? `**${String(o.title)}**` : null, o.summary ? String(o.summary) : null, ...(Array.isArray(o.points) ? o.points.map((p) => `- ${String(p)}`) : []), b.kind === 'approval_preview' ? `_Preview only — nothing was executed${o.action ? ` (${String(o.action)})` : ''}._` : null].filter(Boolean)
  return lines.length ? <PlainAnswer md={lines.join('\n\n')} citeIds={citeIds} onCite={onCite} labelOf={labelOf} /> : null
}

export function PlainAnswer({ md, citeIds, onCite, labelOf }: { md: string; citeIds: string[]; onCite: (id: string) => void; labelOf: (id: string) => string | null }) {
  if (!md) return null
  return <div className="ak-answer"><AskMarkdown md={md} citeIds={citeIds} onCite={onCite} labelOf={labelOf} /></div>
}

/** Only http(s) links are ever rendered as hrefs (the server already restricts them to observed results). */
const safeHref = (url: string | null | undefined) => (url && /^https?:\/\//i.test(url) ? url : undefined)
const hostOf = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, '') } catch { return url } }
const day = (iso: string | null | undefined) => { if (!iso) return null; const d = new Date(iso); return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) }

export function WebCitations({ citations }: { citations: WebCitation[] }) {
  if (!citations.length) return null
  return (
    <section className="ak-web" aria-label="Public web sources">
      <header className="ak-web__h"><span className="ak-eyebrow">Public web</span><small>Not LeadCommand data · retrieved by the model provider</small></header>
      <ol className="ak-web__list">
        {citations.map((c) => (
          <li key={c.url}>
            <a className="ak-web__row" href={safeHref(c.url)} target="_blank" rel="noopener noreferrer nofollow">
              <span className="ak-web__ic" aria-hidden="true"><Glyph name="arrow" size={11} /></span>
              <span className="ak-web__t"><b>{c.title || hostOf(c.url)}</b><small>{hostOf(c.url)}{c.page_age ? ` · ${c.page_age}` : ''}{day(c.retrieved_at) ? ` · retrieved ${day(c.retrieved_at)}` : ''}</small></span>
            </a>
          </li>
        ))}
      </ol>
    </section>
  )
}

export function PropertyResearchCard({ b, onOpen }: { b: Extract<ResultBlock, { kind: 'property_research' }>; onOpen: (href: string) => void }) {
  const internal = b.facts.filter((f) => f.evidence === 'internal')
  const web = b.facts.filter((f) => f.evidence === 'public_web')
  return (
    <section className="ak-prc" aria-label="Property research">
      <header className="ak-prc__h">
        <span className="ak-prc__ic" aria-hidden="true"><Glyph name="property" size={13} /></span>
        <span className="ak-prc__t"><b>{b.address_label || b.title}</b>{b.address_label && b.title !== b.address_label ? <small>{b.title}</small> : null}</span>
        {b.property_id ? <button type="button" className="ak-link" onClick={() => onOpen(`/entity-graph/property/${encodeURIComponent(b.property_id!)}`)}>Open<Glyph name="arrow" size={10} /></button> : null}
      </header>
      {b.listing_status ? (
        <div className="ak-prc__listing">
          <span className="ak-eyebrow">Listing status · public web</span>
          <b>{b.listing_status.status}</b>
          <a href={safeHref(b.listing_status.source_url)} target="_blank" rel="noopener noreferrer nofollow">{hostOf(b.listing_status.source_url)}{b.listing_status.as_of ? ` · ${b.listing_status.as_of}` : ''}</a>
        </div>
      ) : null}
      {b.summary ? <p className="ak-prc__sum">{b.summary}</p> : null}
      <FactGroup title="LeadCommand records" facts={internal} />
      <FactGroup title="Public web" facts={web} web />
      {b.gaps.length ? <div className="ak-prc__gaps"><span className="ak-eyebrow">Gaps / not available</span><ul>{b.gaps.map((g) => <li key={g}>{g}</li>)}</ul></div> : null}
    </section>
  )
}

function FactGroup({ title, facts, web = false }: { title: string; facts: ResultFact[]; web?: boolean }) {
  if (!facts.length) return null
  return (
    <div className={cx('ak-prc__g', web && 'is-web')}>
      <span className="ak-eyebrow">{title}</span>
      <dl>
        {facts.map((f) => (
          <div key={`${f.label}:${f.value}`}>
            <dt>{f.label}</dt>
            <dd>{f.value}{f.source ? (web ? <a href={safeHref(f.source)} target="_blank" rel="noopener noreferrer nofollow" className="ak-prc__src">{hostOf(f.source)}</a> : <code className="ak-prc__src">{f.source}</code>) : null}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
