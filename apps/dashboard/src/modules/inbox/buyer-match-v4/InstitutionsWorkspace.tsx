import type { BuyerMatchV4Projection, InstitutionalPlatform } from './buyer-match-v4.types'
import { fmtCurrency, fmtDate, fmtRange } from './formatters'
import { formatBuyerClassLabel as classLabel } from './buyerFilters'

interface Props {
  projection: BuyerMatchV4Projection | null
  selectedPlatformId: string | null
  expandedPlatformIds: string[]
  onSelectPlatform: (id: string) => void
  onToggleExpand: (id: string) => void
}

function PlatformCard({
  platform,
  selected,
  expanded,
  onSelect,
  onToggleExpand,
}: {
  platform: InstitutionalPlatform
  selected: boolean
  expanded: boolean
  onSelect: () => void
  onToggleExpand: () => void
}) {
  const a = platform.activity
  return (
    <article className={`bmv4-inst-card${selected ? ' is-selected' : ''}`}>
      <header onClick={onSelect} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onSelect()}>
        <div>
          <h4>{platform.platformName}</h4>
          <p className="bmv4-muted">
            {classLabel(platform.platformType)}
            {platform.institutionalSubtype ? ` · ${platform.institutionalSubtype}` : ''}
            {!platform.parentPlatform.verified && ' · Parent platform unresolved'}
          </p>
        </div>
        <div className="bmv4-tabular">
          <span className={`bmv4-grade is-${(platform.matchGrade ?? 'd').toLowerCase().replace('+', 'plus')}`}>
            {platform.matchGrade ?? '—'}
          </span>
          <span>{platform.matchScore ?? '—'}</span>
        </div>
      </header>
      <dl className="bmv4-inst-metrics bmv4-tabular">
        <div><dt>30d</dt><dd>{a.unique30d}</dd></div>
        <div><dt>90d</dt><dd>{a.unique90d}</dd></div>
        <div><dt>180d</dt><dd>{a.unique180d}</dd></div>
        <div><dt>Lifetime</dt><dd>{a.lifetime}</dd></div>
        <div><dt>Local</dt><dd>{a.localZipPurchases}</dd></div>
        <div><dt>Median</dt><dd>{fmtCurrency(a.medianQualifiedPrice)}</dd></div>
        <div><dt>Likely bid</dt><dd>{fmtRange(platform.likelyBidLow, platform.likelyBidHigh)}</dd></div>
        <div><dt>Last</dt><dd>{fmtDate(a.mostRecentPurchase)}</dd></div>
      </dl>
      <button type="button" className="bmv4-btn is-ghost is-sm" onClick={onToggleExpand}>
        {expanded ? 'Hide entity tree' : 'Show entity tree'}
      </button>
      {expanded && (
        <div className="bmv4-entity-tree">
          <div className="bmv4-entity-tree__root">
            {platform.parentPlatform.verified ? platform.parentPlatform.name : platform.platformName}
            <span className="bmv4-muted"> (platform)</span>
          </div>
          <ul>
            {platform.legalEntities.map((le) => (
              <li key={le.entityId}>
                {le.legalName}
                <span className="bmv4-tabular"> · {le.purchaseCount} purchases · {le.relationshipType}</span>
                {le.confidence != null && <span className="bmv4-muted"> · {le.confidence}% conf</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </article>
  )
}

export function InstitutionsWorkspace({
  projection,
  selectedPlatformId,
  expandedPlatformIds,
  onSelectPlatform,
  onToggleExpand,
}: Props) {
  const platforms = projection?.institutionalPlatforms ?? []
  const selected = platforms.find((p) => p.platformId === selectedPlatformId) ?? null

  if (!platforms.length) {
    return (
      <main className="bmv4-institutions bmv4-institutions--empty">
        <h3>Institutional Intelligence</h3>
        <p>No verified institutional platforms matched near this subject.</p>
      </main>
    )
  }

  return (
    <main className="bmv4-institutions">
      <header className="bmv4-directory__head">
        <h3>Institutional Platforms</h3>
        <p className="bmv4-tabular">{platforms.length} verified institutional platforms</p>
      </header>
      <div className="bmv4-inst-grid">
        {platforms.map((p) => (
          <PlatformCard
            key={p.platformId}
            platform={p}
            selected={selectedPlatformId === p.platformId}
            expanded={expandedPlatformIds.includes(p.platformId)}
            onSelect={() => onSelectPlatform(p.platformId)}
            onToggleExpand={() => onToggleExpand(p.platformId)}
          />
        ))}
      </div>
      {selected && (
        <aside className="bmv4-inst-profile">
          <h4>Strategy profile — {selected.platformName}</h4>
          <p className="bmv4-muted">Inferred criteria</p>
          <dl className="bmv4-dossier__dl">
            <div><dt>Target asset types</dt><dd>{selected.strategyProfile.targetAssetTypes.join(', ') || 'Unknown'}</dd></div>
            <div><dt>Target ZIPs</dt><dd>{selected.strategyProfile.targetZips.slice(0, 8).join(', ') || 'Unknown'}</dd></div>
            <div><dt>Typical price range</dt><dd>{fmtRange(selected.strategyProfile.typicalPriceMin, selected.strategyProfile.typicalPriceMax)}</dd></div>
            <div><dt>Single vs package</dt><dd>{selected.strategyProfile.singleAssetVsPackage.singleAssetPct ?? '—'}% / {selected.strategyProfile.singleAssetVsPackage.packagePct ?? '—'}%</dd></div>
            <div><dt>Relationship confidence</dt><dd>{selected.parentPlatform.verified ? 'Verified parent' : 'Unresolved'}</dd></div>
          </dl>
        </aside>
      )}
    </main>
  )
}