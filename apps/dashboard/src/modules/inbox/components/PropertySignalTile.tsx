import { memo } from 'react'
import type { PropertySignalTileModel, PropertyTileGlyph } from '../inbox-card-signals'

/**
 * THE INBOX'S PROPERTY VISUAL, WITH ZERO NETWORK COST.
 *
 * This replaces InboxStreetViewThumb, which built a Street View Static URL per
 * card and mounted an <img> for it. A 25-row page therefore fired up to 25
 * billed Street View requests on load, again on every category switch, filter,
 * search and re-render that changed the URL — for a 184x138 thumbnail nobody
 * makes a decision from. Street View stays where an operator is actually
 * looking at a property: Property Intelligence, Deal Intelligence, Comp
 * Intelligence, Map.
 *
 * What replaces it is not a placeholder. The tile shows the four things that
 * decide whether a thread is worth opening — asset type, value, equity, market
 * — which a photograph of a roof never told anyone. Missing values are OMITTED,
 * never rendered as "—" or "0%": a sparse tile is honest, a zero is a claim.
 *
 * Implementation constraints (this renders once per row, hundreds per session):
 * no canvas, no WebGL, no animation loop, no timers, no observers, no remote
 * imagery. One inline SVG glyph and CSS gradients, both static.
 */

type Props = {
  model: PropertySignalTileModel
  size?: 'rail' | 'row' | 'header'
  className?: string
}

/**
 * Ghosted architectural glyphs — a parcel/elevation abstraction per asset
 * class, not an illustration of a house. Single path each, no strokes that
 * need scaling logic.
 */
function TileGlyph({ glyph }: { glyph: PropertyTileGlyph }) {
  const common = {
    viewBox: '0 0 48 48',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.25,
    strokeLinejoin: 'round' as const,
    strokeLinecap: 'round' as const,
    'aria-hidden': true,
    focusable: 'false' as const,
    className: 'nx-pst__glyph-svg',
  }

  switch (glyph) {
    case 'multifamily':
      return (
        <svg {...common}>
          <path d="M10 42V14l10-5 10 5v28" />
          <path d="M30 42V22l8-4v24" />
          <path d="M15 20h4M21 20h4M15 27h4M21 27h4M15 34h4M21 34h4M33 26h3M33 33h3" />
          <path d="M6 42h36" />
        </svg>
      )
    case 'condo':
      return (
        <svg {...common}>
          <path d="M14 42V10h20v32" />
          <path d="M19 16h4M25 16h4M19 23h4M25 23h4M19 30h4M25 30h4" />
          <path d="M8 42h32" />
        </svg>
      )
    case 'townhome':
      return (
        <svg {...common}>
          <path d="M8 42V22l8-7 8 7v20" />
          <path d="M24 42V22l8-7 8 7v20" />
          <path d="M13 30h6M29 30h6" />
          <path d="M5 42h38" />
        </svg>
      )
    case 'land':
      return (
        <svg {...common}>
          <path d="M6 34l12-7 12 7 12-7" />
          <path d="M6 34v6h36v-6" />
          <path d="M18 27V13M18 13l7 3-7 3" />
        </svg>
      )
    case 'commercial':
      return (
        <svg {...common}>
          <path d="M8 42V16h32v26" />
          <path d="M14 22h6M28 22h6M14 29h6M28 29h6M14 36h6M28 36h6" />
          <path d="M4 42h40M20 16V10h8v6" />
        </svg>
      )
    case 'sfr':
      return (
        <svg {...common}>
          <path d="M10 42V21l14-10 14 10v21" />
          <path d="M20 42V30h8v12" />
          <path d="M6 42h36M15 26h4M29 26h4" />
        </svg>
      )
    default:
      return (
        <svg {...common}>
          <path d="M12 42V20l12-8 12 8v22" />
          <path d="M8 42h32" />
        </svg>
      )
  }
}

const PropertySignalTileComponent = ({ model, size = 'rail', className = '' }: Props) => {
  const { typeLine, valueLine, equityLine, marketLine, glyph } = model

  // With nothing to say the tile stays a surface rather than printing
  // placeholder text — a card whose property data never loaded should look
  // sparse, not broken.
  const hasContent = Boolean(typeLine || valueLine || equityLine || marketLine)

  return (
    <div
      className={`nx-pst is-size-${size} is-glyph-${glyph}${hasContent ? '' : ' is-empty'} ${className}`.trim()}
      aria-hidden="true"
    >
      <span className="nx-pst__linework" />
      <span className="nx-pst__glyph">
        <TileGlyph glyph={glyph} />
      </span>
      <span className="nx-pst__stack">
        {typeLine ? <span className="nx-pst__type">{typeLine}</span> : null}
        {valueLine ? <span className="nx-pst__value">{valueLine}</span> : null}
        {equityLine ? <span className="nx-pst__equity">{equityLine}</span> : null}
        {marketLine ? <span className="nx-pst__market">{marketLine}</span> : null}
      </span>
    </div>
  )
}

export const PropertySignalTile = memo(PropertySignalTileComponent)
PropertySignalTile.displayName = 'PropertySignalTile'
