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
    <div className="ci-detail-popover ci-selected-comp-preview" role="dialog" aria-label="Selected comp preview">
      <div className="ci-detail-popover__img">
        <StreetViewThumb
          address={row.address}
          lat={row.geography.latitude}
          lng={row.geography.longitude}
          size="popover"
        />
      </div>
      <div className="ci-detail-popover__head">
        <div>
          <strong className="ci-detail-popover__price tabular-nums">{fmtCurrency(row.sale_price)}</strong>
          <span className="ci-detail-popover__addr">{row.address ?? 'Address unknown'}</span>
        </div>
        <button type="button" className="ci-popover__close" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <div className="ci-detail-popover__body">
        <PreviewRow label="Sold date" value={fmtDate(row.sale_date)} />
        <PreviewRow label="Distance" value={row.geography.distance_miles != null ? `${row.geography.distance_miles.toFixed(2)} mi` : '—'} />
        <PreviewRow label="Beds / baths" value={`${row.bedrooms ?? '—'} / ${row.bathrooms ?? '—'}`} />
        <PreviewRow label="Square feet" value={row.square_feet ? fmtNum(row.square_feet) : '—'} />
        <PreviewRow label="Price / sqft" value={fmtPpsf(ppsf)} />
        <PreviewRow label="Match quality" value={`${quality} · ${match}`} />
      </div>
      <div className="ci-detail-popover__actions">
        <button type="button" className="ci-pop-action is-primary" onClick={onViewFull}>View full comp</button>
      </div>
    </div>
  )
}

function PreviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="ci-detail-popover__row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}