import { memo } from 'react'
import { cx, LCTooltip } from '../../../shared/lc'
import type { RecentSale } from '../../../domain/comp-intelligence/comps-evidence-api'
import type { RecentSaleView } from '../../../domain/comp-intelligence/recent-sale-facts'
import { fmtAge, fmtDate, fmtInt, fmtMiles, fmtMoney } from '../../../domain/comp-intelligence/comps-workstation-model'
import { displayAddress } from '../utils/comp-display'
import { CompStreetView } from './CompStreetView'
import { SaleTypeBadge } from './SaleType'
import { BuyerTypeChip } from './BuyerType'

const DAY = 86_400_000

function specLine(s: RecentSale): string {
  const parts: Array<string | null> = []
  if (s.units && s.units >= 2) parts.push(`${s.units} units`)
  else {
    parts.push(s.beds !== null ? `${s.beds} bd` : null)
    parts.push(s.baths !== null ? `${s.baths} ba` : null)
  }
  parts.push(s.sqft ? `${fmtInt(s.sqft)} sf` : null)
  parts.push(s.yearBuilt ? `${s.yearBuilt}` : null)
  parts.push(s.propertyType)
  return parts.filter(Boolean).join(' · ')
}

/**
 * One canonical recorded sale near the subject (mv_map_market_sales). Browse
 * evidence only: it is not scored, not in the engine's valuation and cannot be
 * included in a set. It reads like a comp: channel chip + ONE buyer chip,
 * distance and date, the spec, the price and $/sf, and the flags the record
 * supports (cash, flip / resale, portfolio, non-arm's-length). The price rule
 * is the owner's: price > 0 is a priced sale; otherwise the row is transaction
 * activity and shows no price or $/sf.
 */
export const RecentSaleRow = memo(function RecentSaleRow({ s, now, view }: { s: RecentSale; now: number; view: RecentSaleView }) {
  const days = s.soldOn && now ? Math.max(0, Math.round((now - Date.parse(s.soldOn)) / DAY)) : null
  const spec = specLine(s)
  return (
    <div role="listitem" data-recent-sale="" data-key={s.key} className={cx('ciw-row', 'is-static', 'is-recent', !s.priced && 'is-activity')}>
      <CompStreetView className="ciw-row__photo" size="thumb" lat={s.lat} lng={s.lng} address={s.address} load="visible" />
      <div className="ciw-row__main">
        <div className="ciw-row__title">
          <span className="ciw-row__addr">{displayAddress(s.address) ?? 'Address not recorded'}</span>
          {!s.priced ? <span className="ciw-pill" title="Recorded transfer with no usable price — counted as activity, never as a priced comp">Activity</span> : null}
        </div>
        <div className="ciw-row__meta lc-num">
          <SaleTypeBadge v={view.channel} />
          <BuyerTypeChip t={view.buyer} />
          <span>{[fmtMiles(s.distanceMiles), s.soldOn ? `${fmtDate(s.soldOn)}${days !== null ? ` · ${fmtAge(days)}` : ''}` : 'Undated sale'].filter(Boolean).join(' · ')}</span>
        </div>
        {spec ? <div className="ciw-row__spec lc-num">{spec}</div> : null}
        {view.flags.length ? (
          <div className="ciw-row__flags" data-recent-flags="">
            {view.flags.map((f) => (
              <LCTooltip key={f.key} content={f.hint}><span className="ciw-flag" data-flag={f.key} tabIndex={0}>{f.label}</span></LCTooltip>
            ))}
          </div>
        ) : null}
      </div>
      <div className="ciw-row__figures lc-num">
        {s.priced ? (
          <>
            <b className="ciw-row__price">{fmtMoney(s.price) ?? '—'}</b>
            <span className="ciw-row__unit">{s.ppsf ? `$${fmtInt(s.ppsf)}/sf` : ' '}</span>
          </>
        ) : <span className="ciw-row__unit">no price recorded</span>}
      </div>
    </div>
  )
})
