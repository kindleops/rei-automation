import type { ReactNode } from 'react'
import { CopilotOrb } from '../../../shared/copilot/CopilotOrb'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

export const CopilotOrbTrigger = ({
  onClick,
  active = false,
  isReady = true,
  size = 'md',
  children,
}: {
  onClick?: any
  active?: boolean
  isReady?: boolean
  size?: string
  children?: ReactNode
}) => (
  <div
    className={cls('nx-copilot-orb-trigger', active && 'is-active', !isReady && 'is-disabled', `is-${size}`)}
  >
    <CopilotOrb
      state={active ? 'listening' : 'idle'}
      amplitude={active ? 0.4 : 0}
      onClick={() => onClick?.()}
      onPushToTalk={() => {}}
      onPushToTalkRelease={() => {}}
    />
    {children ? <span>{children}</span> : null}
  </div>
)
