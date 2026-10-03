import { Icon } from '../../shared/icons'
import { cx } from '../../shared/lc'
import { objectAttrs } from '../desktop/objects'
import { openCitation } from './brief-actions'
import { isNewSince, SECTION_LABEL, type BriefLine } from './brief-model'

/** The brief's statements: text, its evidence line, and the citation it opens. */
export function BriefLines({ lines, lastSeen, dense, sections = true, onOpen }: { lines: BriefLine[]; lastSeen: number | null; dense?: boolean; sections?: boolean; onOpen?: () => void }) {
  return (
    <ol className={cx('bf-lines', dense && 'is-dense')}>
      {lines.map((l) => {
        const fresh = isNewSince(l, lastSeen)
        const go = Boolean(l.cite.ref || l.cite.path)
        return (
          <li key={l.id} className={cx('bf-line', `is-${l.tone}`, fresh && 'is-new')}>
            <span className="bf-line__mark" aria-hidden="true"><Icon name={l.icon} size={12} /></span>
            <button type="button" className="bf-line__body" disabled={!go} onClick={(e) => { openCitation(l, e); onOpen?.() }} {...objectAttrs(l.cite.ref)} title={`Opens ${l.cite.label} — source: ${l.cite.source}`}>
              <span className="bf-line__text">{l.text}{fresh ? <em className="bf-new">new</em> : null}</span>
              {l.detail && !dense ? <span className="bf-line__detail">{l.detail}</span> : null}
              <span className="bf-cite">
                {sections ? <b>{SECTION_LABEL[l.section]}</b> : null}
                <span>{l.cite.label}</span>
                {go ? <Icon name="arrow-up-right" size={10} /> : null}
              </span>
            </button>
          </li>
        )
      })}
    </ol>
  )
}
