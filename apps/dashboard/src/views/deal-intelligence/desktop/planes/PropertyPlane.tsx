import { useState } from 'react'
import { Icon } from '../../../../shared/icons'
import { cx, LCIconButton, LCSegmented } from '../../../../shared/lc'
import { staticStreetViewUrl } from '../../../../modules/entity-graph/mobile/EntityGraphPropertyVisual'
import { InteractiveStreetViewPanorama } from '../../../../modules/deal-intelligence/InteractiveStreetViewPanorama'
import { getCachedStreetViewStatus, rememberStreetViewResult } from '../../../../modules/inbox/utils/streetViewImageCache'
import { int, splitAddress, usd } from '../di-format'
import { recordField } from '../di-model'
import type { DiDecision } from '../di-types'

type View = 'still' | 'pano'
type Still = 'idle' | 'ok' | 'failed'

/** A previously-known result for this exact URL, so a revisit never re-probes. */
const cachedStill = (url: string | null): Still => {
  const c = url ? getCachedStreetViewStatus(url) : 'unknown'
  return c === 'ok' ? 'ok' : c === 'failed' ? 'failed' : 'idle'
}

/**
 * The property, refined: one Street View frame for this single subject (the
 * fan-out rule allows exactly one intentional request on a detail surface),
 * a pannable panorama only when asked for, and the facts that describe the
 * asset. Imagery sources are the ones the app already has — no new ones.
 */
export function PropertyPlane({ d, onOpenMedia, compact }: { d: DiDecision; onOpenMedia: () => void; compact?: boolean }) {
  const s = d.subject
  const url = staticStreetViewUrl(s.address, s.lat, s.lng)
  const [view, setView] = useState<View>('still')
  const [seen, setSeen] = useState(url)
  const [state, setState] = useState<Still>(() => cachedStill(url))
  if (seen !== url) {
    setSeen(url)
    setView('still')
    setState(cachedStill(url))
  }
  const { street, locality } = splitAddress(s.address)
  const condition = recordField(d, 'Structure', 'Condition')
  const lot = recordField(d, 'Lot & location', 'Lot size')
  const county = recordField(d, 'Lot & location', 'County')
  const specs = [
    s.propertyType,
    s.units && s.units > 1 ? `${s.units} units` : null,
    s.beds ? `${s.beds} bd` : null,
    s.baths ? `${s.baths} ba` : null,
    s.sqft ? `${int(s.sqft)} sf` : null,
    s.yearBuilt ? `Built ${s.yearBuilt}` : null,
  ].filter(Boolean) as string[]

  return (
    <section className={cx('dr-plane dr-prop is-d2', compact && 'is-compact')} data-plane="property" aria-label="Property">
      <div className={cx('dr-prop__media', state === 'ok' && 'is-ready', view === 'pano' && 'is-pano')}>
        {view === 'pano' ? (
          <InteractiveStreetViewPanorama address={s.address} lat={s.lat} lng={s.lng} visible onFailure={() => setView('still')} />
        ) : url && state !== 'failed' ? (
          <img
            src={url}
            alt={s.address ? `Street View of ${s.address}` : 'Street View'}
            decoding="async"
            onLoad={() => { setState('ok'); rememberStreetViewResult(url, true) }}
            onError={() => { setState('failed'); rememberStreetViewResult(url, false) }}
          />
        ) : (
          <div className="dr-prop__none">
            <Icon name="eye" size={16} />
            <span>{url ? 'No Street View imagery at this location' : 'No coordinates or address to locate imagery'}</span>
          </div>
        )}
        <div className="dr-prop__scrim" aria-hidden="true" />
        <div className="dr-prop__tools">
          <LCSegmented
            size="sm"
            label="Imagery"
            value={view}
            onChange={(v) => setView(v)}
            options={[{ value: 'still', label: 'Street View' }, { value: 'pano', label: 'Look around' }]}
          />
          <LCIconButton icon="maximize" size="sm" variant="glass" label="Open imagery" onClick={onOpenMedia} />
        </div>
      </div>
      <div className="dr-prop__body">
        <div className="dr-prop__title">
          <b>{street ?? 'Address not recorded'}</b>
          {locality ? <span>{locality}</span> : null}
        </div>
        {specs.length ? <div className="dr-prop__specs">{specs.map((x) => <span key={x}>{x}</span>)}</div> : null}
        <dl className="dr-prop__facts">
          {condition ? <div><dt>Condition</dt><dd>{condition}<em>record</em></dd></div> : null}
          {lot ? <div><dt>Lot</dt><dd>{lot}</dd></div> : null}
          {county ? <div><dt>County</dt><dd>{county}</dd></div> : null}
          {s.zip ? <div><dt>ZIP</dt><dd>{s.zip}</dd></div> : null}
          {s.mls?.status ? <div><dt>MLS</dt><dd>{s.mls.status}{s.mls.listPrice ? ` · ${usd(s.mls.listPrice)}` : ''}</dd></div> : null}
        </dl>
      </div>
    </section>
  )
}
