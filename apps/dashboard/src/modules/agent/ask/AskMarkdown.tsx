import { Fragment, type ReactNode } from 'react'

/**
 * A small, SAFE Markdown renderer for agent answers — React nodes only, never
 * innerHTML. Headings, bullet / numbered lists, paragraphs, **bold**, *em*,
 * `code`. Property ids the run read become inline citation buttons.
 */
export function AskMarkdown({ md, citeIds = [], onCite, labelOf }: { md: string; citeIds?: string[]; onCite?: (id: string) => void; labelOf?: (id: string) => string | null }) {
  const blocks = parseBlocks(md)
  const inline = (s: string, k: string) => renderInline(s, k, citeIds, onCite, labelOf)
  return (
    <div className="agx-md">
      {blocks.map((b, i) => {
        const k = `b${i}`
        if (b.type === 'h') { const H = (b.level <= 2 ? 'h4' : 'h5') as 'h4' | 'h5'; return <H key={k}>{inline(b.text, k)}</H> }
        if (b.type === 'ul') return <ul key={k}>{b.items.map((it, j) => <li key={j}>{inline(it, `${k}-${j}`)}</li>)}</ul>
        if (b.type === 'ol') return <ol key={k}>{b.items.map((it, j) => <li key={j}>{inline(it, `${k}-${j}`)}</li>)}</ol>
        if (b.type === 'p') return <p key={k}>{inline(b.text, k)}</p>
        return null
      })}
    </div>
  )
}

type Block = { type: 'h'; level: number; text: string } | { type: 'ul'; items: string[] } | { type: 'ol'; items: string[] } | { type: 'p'; text: string }

export function parseBlocks(md: string): Block[] {
  const out: Block[] = []
  let para: string[] = []
  let list: { type: 'ul' | 'ol'; items: string[] } | null = null
  const flushPara = () => { if (para.length) { out.push({ type: 'p', text: para.join(' ') }); para = [] } }
  const flushList = () => { if (list) { out.push(list); list = null } }
  for (const raw of md.replace(/\r/g, '').split('\n')) {
    const line = raw.trimEnd()
    const h = /^(#{1,6})\s+(.*)$/.exec(line.trim())
    const ul = /^\s*[-*•]\s+(.*)$/.exec(line)
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (!line.trim()) { flushPara(); flushList(); continue }
    if (h) { flushPara(); flushList(); out.push({ type: 'h', level: h[1].length, text: h[2] }); continue }
    if (ul || ol) {
      flushPara()
      const type = ul ? 'ul' : 'ol'
      if (!list || list.type !== type) { flushList(); list = { type, items: [] } }
      list.items.push((ul ?? ol)![1])
      continue
    }
    if (list && /^\s{2,}\S/.test(raw)) { list.items[list.items.length - 1] += ` ${line.trim()}`; continue }
    flushList()
    // a line that is wholly bold reads as a heading (“**Evidence**”)
    const bh = /^\*\*([^*]{1,60})\*\*:?$/.exec(line.trim())
    if (bh) { flushPara(); out.push({ type: 'h', level: 3, text: bh[1] }); continue }
    para.push(line.trim())
  }
  flushPara(); flushList()
  return out
}

function renderInline(s: string, key: string, citeIds: string[], onCite?: (id: string) => void, labelOf?: (id: string) => string | null): ReactNode {
  const parts: ReactNode[] = []
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g
  let last = 0
  let m: RegExpExecArray | null
  let n = 0
  const text = (t: string) => cite(t, `${key}-t${n++}`, citeIds, onCite, labelOf)
  while ((m = re.exec(s))) {
    if (m.index > last) parts.push(text(s.slice(last, m.index)))
    const tok = m[0]
    if (tok.startsWith('**')) parts.push(<strong key={`${key}-s${n++}`}>{cite(tok.slice(2, -2), `${key}-b${n++}`, citeIds, onCite, labelOf)}</strong>)
    else if (tok.startsWith('`')) parts.push(<code key={`${key}-c${n++}`}>{tok.slice(1, -1)}</code>)
    else parts.push(<em key={`${key}-e${n++}`}>{tok.slice(1, -1)}</em>)
    last = m.index + tok.length
  }
  if (last < s.length) parts.push(text(s.slice(last)))
  return <>{parts}</>
}

function cite(t: string, key: string, ids: string[], onCite?: (id: string) => void, labelOf?: (id: string) => string | null): ReactNode {
  if (!ids.length || !onCite) return <Fragment key={key}>{t}</Fragment>
  const re = new RegExp(`\\b(${ids.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'g')
  const out: ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(t))) {
    if (m.index > last) out.push(t.slice(last, m.index))
    const id = m[1]
    out.push(<button key={`${key}-${i++}`} type="button" className="agx-cite" title={`${labelOf?.(id) ?? `Property ${id}`} — open in Entity Graph`} onClick={() => onCite(id)}>{id}</button>)
    last = m.index + id.length
  }
  if (!out.length) return <Fragment key={key}>{t}</Fragment>
  if (last < t.length) out.push(t.slice(last))
  return <Fragment key={key}>{out}</Fragment>
}
