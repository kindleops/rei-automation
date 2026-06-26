interface Props {
  state: 'loading_subject' | 'loading_comps' | 'no_coords' | 'no_comps' | 'degraded' | 'style_error' | 'no_coord_evidence' | 'comps_only'
  detail?: string | null
}

const COPY: Record<Props['state'], { title: string; body: string }> = {
  loading_subject: {
    title: 'Resolving subject',
    body: 'Loading canonical subject coordinates and evidence contract.',
  },
  loading_comps: {
    title: 'Loading transaction evidence',
    body: 'Subject resolved. Comp candidates are loading into the map.',
  },
  no_coords: {
    title: 'Subject coordinates unresolved',
    body: 'Exact parcel coordinates are required for spatial evidence. Decision intelligence remains available in the right panel.',
  },
  no_comps: {
    title: 'Subject resolved — no comps in radius',
    body: 'The map shows the subject location. Expand radius or review rejection reasons in transaction evidence.',
  },
  degraded: {
    title: 'V3 decision evidence unavailable',
    body: 'Evidence-only degraded recovery is active. Map may show candidate rows without authoritative valuation.',
  },
  style_error: {
    title: 'Map style failed to load',
    body: 'Basemap tiles are unavailable. Retry or check network connectivity.',
  },
  no_coord_evidence: {
    title: 'Evidence without coordinates',
    body: 'Transaction evidence loaded but no usable lat/lng pairs were found for map markers.',
  },
  comps_only: {
    title: 'Comp evidence map',
    body: 'Subject pin unavailable. Displaying recovered comp coordinates.',
  },
}

export function MapStatePanel({ state, detail }: Props) {
  const copy = COPY[state]
  return (
    <div className="ci-map-state-panel" role="status">
      <strong>{copy.title}</strong>
      <p>{copy.body}</p>
      {detail && <p className="ci-map-state-panel__detail">{detail}</p>}
    </div>
  )
}