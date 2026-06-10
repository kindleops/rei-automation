import { useState } from 'react'
import { USA_STATE_PATHS } from '../../../lib/data/usaStatePaths'

export interface StateMetrics {
  state: string
  sent: number
  delivered: number
  replies: number
  positive: number
  optOuts: number
  spend: number
  activeSellers: number
  contracts: number
  performanceColor?: string
}

interface USAMapProps {
  data: Record<string, StateMetrics>
  onStateClick?: (stateCode: string) => void
  onHoverState?: (stateCode: string | null) => void
  highlightedState?: string | null
}

export const USAMap = ({ data, onStateClick, onHoverState, highlightedState }: USAMapProps) => {
  const [hovered, setHovered] = useState<string | null>(null)

  const handleMouseEnter = (code: string) => {
    setHovered(code)
    onHoverState?.(code)
  }

  const handleMouseLeave = () => {
    setHovered(null)
    onHoverState?.(null)
  }

  return (
    <div className="nx-usa-map">
      <svg
        viewBox="0 0 960 600"
        className="nx-usa-map__svg"
        style={{ width: '100%', height: 'auto', display: 'block' }}
      >
        <defs>
          <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="2" result="blur" />
            <feComposite in="SourceGraphic" in2="blur" operator="over" />
          </filter>
        </defs>
        
        {Object.entries(USA_STATE_PATHS).map(([code, { path, cx, cy }]) => {
          const metrics = data[code]
          const isHighlighted = highlightedState === code
          const isHovered = hovered === code
          
          // Determine fill based on metrics or default
          const fill = metrics?.performanceColor || 'rgba(255, 255, 255, 0.05)'
          const stroke = isHighlighted || isHovered ? '#fff' : 'rgba(255, 255, 255, 0.15)'
          const strokeWidth = isHighlighted || isHovered ? 2 : 1
          
          return (
            <g
              key={code}
              className={`nx-usa-map__state ${isHighlighted ? 'is-highlighted' : ''} ${isHovered ? 'is-hovered' : ''}`}
              onClick={() => onStateClick?.(code)}
              onMouseEnter={() => handleMouseEnter(code)}
              onMouseLeave={handleMouseLeave}
              style={{ cursor: 'pointer' }}
            >
              <path
                d={path}
                fill={fill}
                stroke={stroke}
                strokeWidth={strokeWidth}
                style={{
                  transition: 'all 0.2s ease',
                  filter: isHovered || isHighlighted ? 'url(#glow)' : 'none'
                }}
              />
              {/* Show label for larger states or if hovered/highlighted */}
              {(isHovered || isHighlighted) && (
                <text
                  x={cx}
                  y={cy}
                  textAnchor="middle"
                  fill="#fff"
                  fontSize="10"
                  fontWeight="bold"
                  style={{ pointerEvents: 'none', textShadow: '0 0 4px rgba(0,0,0,0.8)' }}
                >
                  {code}
                </text>
              )}
            </g>
          )
        })}
      </svg>
    </div>
  )
}
