import type { CompTransactionEvidence } from '../../../domain/comp-intelligence/v3-types'
import { StreetViewThumb } from './StreetViewThumb'
import {
  compMatchLabel,
  compQuality,
  compQualityLabel,
  fmtCurrency,
  fmtDate,
  fmtNum,
  fmtPpsf,
  pricePerSqft,
} from '../utils/comp-display'

interface Props {
  row: CompTransactionEvidence
  onClose: () => void
  onViewFull: () => void
}

export function SelectedCompPreview({ row, onClose, onViewFull }: Props) {
  const quality = compQualityLabel(compQuality(row))
  const match = compMatchLabel(row)
  const ppsf = pricePerSqft(row)

  return (
    <div className="ci-map-comp-preview" role="dialog" aria-label="Selected comp preview">
      <button type="button" className="ci-map-comp-preview__close" onClick={onClose} aria-label="Close">×</button>
      <div className="ci-map-comp-preview__media">
        <StreetViewThumb
          address={row.address}
          lat={row.geography.latitude}
          lng={row.geography.longitude}
          size="preview"
        />
      </div>
      <div className="ci-map-comp-preview__body">
        <div className="ci-map-comp-preview__price tabular-nums">{fmtCurrency(row.sale_price)}</div>
        <div className="ci-map-comp-preview__addr">{row.address ?? 'Address unknown'}</div>
        <div className="ci-map-comp-preview__facts">
          <span>{fmtDate(row.sale_date)}</span>
          <span>{row.geography.distance_miles != null ? `${row.geography.distance_miles.toFixed(2)} mi` : '—'}</span>
          <span>{row.bedrooms ?? '—'} bd / {row.bathrooms ?? '—'} ba</span>
          <span>{row.square_feet ? `${fmtNum(row.square_feet)} sf` : '—'}</span>
          <span>{fmtPpsf(ppsf)}</span>
          <span>{quality} · {match}</span>
        </div>
        <button type="button" className="ci-map-comp-preview__cta" onClick={onViewFull}>View Full Comp</button>
      </div>
    </div>
  )
}