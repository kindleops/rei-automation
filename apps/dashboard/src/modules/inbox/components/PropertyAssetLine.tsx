import { memo } from 'react'
import type { PropertySignalTileModel } from '../inbox-card-signals'

/**
 * THE PROPERTY FACTS, AS A LINE OF THE CARD — NOT AS A PICTURE FRAME.
 *
 * The phone card carried a 78x58 media box where the Street View thumbnail used
 * to be. Street View was removed from list rows (25 rows meant up to 25 billed
 * requests per load), and PropertySignalTile filled the frame with the four
 * facts instead — but it kept the frame's shape, so the facts arrived as four
 * stacked 9px lines inside a rounded box that still read as a photo that failed
 * to load. It cost 78px of a 390px row to say less than one line of type can.
 *
 * Same four facts, same model, no frame: asset class and market on the left,
 * the two numbers an operator triages on pushed to the right, set in the card's
 * own type scale. Nothing is invented and nothing is zero-filled — a missing
 * value is omitted, exactly as the tile omitted it, and with every value missing
 * the line does not render at all.
 *
 * Negative equity is flagged rather than left to inherit the accent tint the
 * positive figures use: "-3% EQ" in the same colour as "85% EQ" reads as a
 * qualifying number when it is a disqualifying one.
 *
 * Mobile only. Desktop rows have the horizontal room for the tile and keep it;
 * this element is display:none outside the mobile shell.
 */

type Props = {
  model: PropertySignalTileModel
  /**
   * Off where the surface already states the market. The inbox row prints the
   * full address two lines up, so repeating "MIAMI, FL" beside it spends the
   * width that the value and equity figures need.
   */
  market?: boolean
  className?: string
}

const PropertyAssetLineComponent = ({ model, market = true, className = '' }: Props) => {
  const { typeLine, valueLine, equityLine } = model
  const marketLine = market ? model.marketLine : null
  if (!typeLine && !valueLine && !equityLine && !marketLine) return null

  return (
    <div className={`nx-card-assetline ${className}`.trim()}>
      {typeLine ? <span className="nx-card-assetline__type">{typeLine}</span> : null}
      {marketLine ? <span className="nx-card-assetline__market">{marketLine}</span> : null}
      {valueLine ? <span className="nx-card-assetline__value tabular-nums">{valueLine}</span> : null}
      {equityLine ? (
        <span
          className={`nx-card-assetline__equity tabular-nums${equityLine.trimStart().startsWith('-') ? ' is-negative' : ''}`}
        >
          {equityLine}
        </span>
      ) : null}
    </div>
  )
}

export const PropertyAssetLine = memo(PropertyAssetLineComponent)
PropertyAssetLine.displayName = 'PropertyAssetLine'
