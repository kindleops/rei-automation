/**
 * The comp HOVER preview — a glass capsule tethered to the pin. Renders only
 * what the feature carries (and a record already hydrated by an earlier
 * click). No request is made here, ever.
 */
import { createPortal } from 'react-dom'
import { cx } from '../../../../shared/lc'
import { mapOverlayTarget } from '../../map-overlay-host'
import { hoverPreviewFromFeature, type CompRecord, type CompSubject } from './comp-card-model'
import type { CompHoverState } from './comp-hover'
import './comp-card.css'

const W = 268

export function CompHoverPreview({ hover, subject, hydrated, now, bounds }: {
  hover: CompHoverState
  subject: CompSubject | null
  hydrated: CompRecord | null
  now: number
  /** the overlay host's size, for edge flipping */
  bounds: { width: number; height: number }
}) {
  const m = hoverPreviewFromFeature(hover.props, hover.lngLat, subject, now, hydrated)
  const { x, y } = hover.point
  const flipX = x + 18 + W > bounds.width - 12
  const flipY = y - 150 < 12
  const style = {
    left: flipX ? Math.max(12, x - 18 - W) : x + 18,
    top: flipY ? y + 16 : undefined,
    bottom: flipY ? undefined : Math.max(12, bounds.height - y + 16),
    width: W,
  }
  return createPortal(
    <div className={cx('mcc-hover', m.cluster && 'is-cluster', m.institutional && 'is-institutional')} style={style} role="tooltip" data-map-card="comp-hover" data-comp-key={m.key}>
      <div className="mcc-hover__kicker">
        <span className="mcc-dot" aria-hidden="true" />
        <span>{m.cluster ? `${m.count.toLocaleString('en-US')} sales here` : m.source ?? 'Sale'}</span>
        {m.corpus === 'engine_pool' ? <span className="mcc-tag is-exec">Engine pool</span> : null}
        {m.portfolio ? <span className="mcc-tag">{m.portfolio}</span> : null}
      </div>
      <div className="mcc-hover__price lc-num">
        <strong>{m.headline}</strong>
        {m.headlineNote ? <span>{m.headlineNote}</span> : null}
      </div>
      <div className="mcc-hover__meta lc-num">
        <span>{m.date}</span>
        {!m.cluster && m.age !== '—' ? <span>{m.age}</span> : null}
        {m.distance ? <span>{m.distance} from subject</span> : null}
      </div>
      {m.specs.some((s) => s.value !== '—') ? (
        <dl className="mcc-hover__specs lc-num">
          {m.specs.map((s) => (
            <div key={s.label} className={cx(s.value === '—' && 'is-missing')}><dt>{s.label}</dt><dd>{s.value}</dd></div>
          ))}
        </dl>
      ) : null}
      <div className="mcc-hover__foot">
        {m.buyer ? <span>{m.buyer}</span> : null}
        <span className="mcc-hover__hint">{m.cluster ? 'Click to list or zoom' : 'Click for the full sale'}</span>
      </div>
    </div>,
    mapOverlayTarget(),
  )
}
