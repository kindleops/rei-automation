/** The platform's shared operational vocabulary (see States.tsx · LCStatus). */
export type LCTone = 'exec' | 'ok' | 'attn' | 'crit' | 'flow' | 'neutral' | 'accent'

/* ── STATUS ─────────────────────────────────────────────────────────────── */

/**
 * The platform's shared operational vocabulary. Each maps to ONE tone, so
 * "waiting" is never painted as a failure and "system handling" is calm.
 */
export const LC_STATES = {
  system_handling: { label: 'System handling', tone: 'exec', quiet: true },
  scheduled: { label: 'Scheduled', tone: 'exec', quiet: true },
  running: { label: 'Running', tone: 'exec', quiet: false },
  waiting_seller: { label: 'Waiting on seller', tone: 'neutral', quiet: true },
  waiting_buyer: { label: 'Waiting on buyer', tone: 'neutral', quiet: true },
  waiting_title: { label: 'Waiting on title', tone: 'neutral', quiet: true },
  waiting_provider: { label: 'Waiting on provider', tone: 'neutral', quiet: true },
  needs_you: { label: 'Needs you', tone: 'attn', quiet: false },
  due: { label: 'Due', tone: 'attn', quiet: false },
  overdue: { label: 'Overdue', tone: 'crit', quiet: false },
  blocked: { label: 'Blocked', tone: 'crit', quiet: false },
  degraded: { label: 'Degraded', tone: 'attn', quiet: false },
  failed: { label: 'Failed', tone: 'crit', quiet: false },
  held: { label: 'Held', tone: 'attn', quiet: true },
  ready: { label: 'Ready', tone: 'ok', quiet: false },
  verified: { label: 'Verified', tone: 'ok', quiet: true },
  done: { label: 'Done', tone: 'ok', quiet: true },
  workflow: { label: 'Workflow', tone: 'flow', quiet: true },
  inactive: { label: 'Inactive', tone: 'neutral', quiet: true },
} as const satisfies Record<string, { label: string; tone: LCTone; quiet: boolean }>

export type LCStateKey = keyof typeof LC_STATES

