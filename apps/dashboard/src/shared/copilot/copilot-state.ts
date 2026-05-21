/**
 * NEXUS Copilot — State Machine + Action Engine
 *
 * Provides:
 * - CopilotState: 14 distinct intelligence states
 * - State metadata (labels, colors, orb behavior descriptors)
 * - Normalized action/intent engine for converting natural language → structured ops
 * - Room-aware context resolution
 * - Action permission system
 */

// ── Copilot States ────────────────────────────────────────────────────────

export type CopilotState =
  | 'idle'
  | 'greeting'
  | 'listening'
  | 'transcribing'
  | 'speaking'
  | 'understanding'
  | 'searching'
  | 'analyzing'
  | 'planning'
  | 'drafting'
  | 'executing'
  | 'confirming'
  | 'completed'
  | 'error'

export interface StateMeta {
  label: string
  sublabel: string
  helper: string
  orbSpeed: number      // pulse frequency multiplier (0 = static, 1 = normal, 3 = fast)
  orbIntensity: number  // glow intensity 0–1
  hue: string           // rgb string for canvas rendering
  accentClass: string   // css modifier
}

export const STATE_META: Record<CopilotState, StateMeta> = {
  idle:          { label: 'Standing by',          sublabel: 'Private deck online',          helper: 'Command surface primed for operator input.',          orbSpeed: 0.28, orbIntensity: 0.14, hue: '56,208,240',  accentClass: 'is-idle' },
  greeting:      { label: 'Initializing',        sublabel: 'Syncing local context',         helper: 'Loading room intelligence, preferences, and operator state.', orbSpeed: 0.82, orbIntensity: 0.28, hue: '56,208,240',  accentClass: 'is-greeting' },
  listening:     { label: 'Listening',           sublabel: 'Voice channel live',            helper: 'Mic is hot. Capturing spoken command input.',         orbSpeed: 1.34, orbIntensity: 0.46, hue: '56,208,240',  accentClass: 'is-listening' },
  transcribing:  { label: 'Transcribing',        sublabel: 'Converting speech to text',     helper: 'Resolving phrase boundaries and command grammar.',    orbSpeed: 1.58, orbIntensity: 0.50, hue: '56,208,240',  accentClass: 'is-transcribing' },
  speaking:      { label: 'Speaking',            sublabel: 'Delivering operator response',  helper: 'Projecting synthesized guidance into the deck.',      orbSpeed: 1.12, orbIntensity: 0.42, hue: '109,192,255', accentClass: 'is-speaking' },
  understanding: { label: 'Understanding',       sublabel: 'Parsing command intent',        helper: 'Normalizing the operator request into structured actions.', orbSpeed: 1.36, orbIntensity: 0.42, hue: '153,102,255', accentClass: 'is-understanding' },
  searching:     { label: 'Searching',           sublabel: 'Querying intelligence graph',   helper: 'Scanning command grammar, context memory, and live surfaces.', orbSpeed: 1.76, orbIntensity: 0.52, hue: '153,102,255', accentClass: 'is-searching' },
  analyzing:     { label: 'Analyzing',           sublabel: 'Evaluating signals',            helper: 'Weighing context, risk, and likely operator intent.', orbSpeed: 1.62, orbIntensity: 0.50, hue: '153,102,255', accentClass: 'is-analyzing' },
  planning:      { label: 'Planning',            sublabel: 'Sequencing mission steps',      helper: 'Generating candidate actions and execution order.',   orbSpeed: 1.38, orbIntensity: 0.46, hue: '153,102,255', accentClass: 'is-planning' },
  drafting:      { label: 'Drafting',            sublabel: 'Preparing operator output',     helper: 'Composing action preview, response text, or next-step guidance.', orbSpeed: 1.16, orbIntensity: 0.38, hue: '44,184,122',  accentClass: 'is-drafting' },
  executing:     { label: 'Executing',           sublabel: 'Acting on approved intent',     helper: 'Dispatching the selected action into the command floor.', orbSpeed: 2.12, orbIntensity: 0.60, hue: '216,149,48',  accentClass: 'is-executing' },
  confirming:    { label: 'Awaiting Approval',   sublabel: 'Operator confirmation required', helper: 'Command is staged and waiting for final approval.',   orbSpeed: 0.62, orbIntensity: 0.32, hue: '216,149,48',  accentClass: 'is-confirming' },
  completed:     { label: 'Complete',            sublabel: 'Mission step resolved',         helper: 'Execution closed successfully. Standing by for next task.', orbSpeed: 0.48, orbIntensity: 0.24, hue: '44,184,122',  accentClass: 'is-completed' },
  error:         { label: 'Error',               sublabel: 'Execution path degraded',       helper: 'An issue interrupted the command. Review trace and retry.', orbSpeed: 0.52, orbIntensity: 0.28, hue: '212,64,76',   accentClass: 'is-error' },
}

// ── Copilot Presence Modes ────────────────────────────────────────────────

export type CopilotMode = 'orb' | 'sidecar' | 'console'

export interface CopilotContext {
  surface: string
  roomPath: string
  entityType?: string
  entityId?: string
  entityLabel?: string
  hotCount?: number
  alertCount?: number
  pendingActions?: number
}

// ── Normalized Intents ────────────────────────────────────────────────────

export type IntentDomain =
  | 'room' | 'map' | 'inbox' | 'alerts' | 'markets'
  | 'buyers' | 'title' | 'split_view' | 'briefing'
  | 'notification' | 'settings' | 'watchlist'
  | 'autopilot' | 'copilot' | 'system'

export type IntentAction = string // e.g. 'open', 'focus', 'zoom_to', 'set_layer', etc.

export interface ResolvedIntent {
  domain: IntentDomain
  action: IntentAction
  params: Record<string, string>
  raw: string
  confidence: number
  preview: string  // human-readable preview
}

// ── Room Context ──────────────────────────────────────────────────────────

export interface RoomContext {
  path: string
  label: string
  room: string
}

export const ROOM_MAP: Record<string, RoomContext> = {
  '/dashboard/live': { path: '/dashboard/live', label: 'Home',           room: 'Command Floor' },
  '/inbox':          { path: '/inbox',          label: 'Inbox',          room: 'Comms Deck' },
  '/alerts':         { path: '/alerts',         label: 'Alerts',         room: 'Threat Board' },
  '/stats':          { path: '/stats',          label: 'Intelligence',   room: 'Strategy Room' },
  '/markets':        { path: '/markets',        label: 'Markets',        room: 'Operations Room' },
  '/buyer':          { path: '/buyer',          label: 'Buyers',         room: 'Capital Deployment' },
  '/title':          { path: '/title',          label: 'Title',          room: 'Execution Room' },
  '/watchlists':     { path: '/watchlists',     label: 'Watchlists',     room: 'Tracked Targets' },
  '/notifications':  { path: '/notifications',  label: 'Notifications',  room: 'Event Stream' },
  '/settings':       { path: '/settings',       label: 'Settings',       room: 'Control Layer' },
}

export function resolveRoom(path: string): RoomContext {
  return ROOM_MAP[path] ?? ROOM_MAP['/dashboard/live']
}

// ── Action Permission ─────────────────────────────────────────────────────

export type ActionPermission = 'read-only' | 'suggest-only' | 'confirm-before' | 'low-risk-auto' | 'full-assist'

export const ACTION_PERMISSION_META: Record<ActionPermission, { label: string; description: string }> = {
  'read-only':      { label: 'Read Only',           description: 'Copilot can only observe and report' },
  'suggest-only':   { label: 'Suggest Only',         description: 'Copilot suggests but never acts' },
  'confirm-before': { label: 'Confirm Before Acting', description: 'All actions require your approval' },
  'low-risk-auto':  { label: 'Low-Risk Auto-Act',    description: 'Navigation and view changes are automatic' },
  'full-assist':    { label: 'Full Operator Assist',  description: 'Copilot acts freely on your behalf' },
}

// ── Intent Parser ─────────────────────────────────────────────────────────

interface IntentRule {
  patterns: RegExp[]
  domain: IntentDomain
  action: IntentAction
  extract?: (match: RegExpMatchArray) => Record<string, string>
  preview: (params: Record<string, string>) => string
}

const INTENT_RULES: IntentRule[] = [
  // Room navigation
  { patterns: [/\b(?:open|go\s+to|navigate\s+to|show)\s+(inbox|comms)/i],
    domain: 'room', action: 'open', extract: () => ({ target: '/inbox' }),
    preview: () => 'Navigate to Comms Deck' },
  { patterns: [/\b(?:open|go\s+to|show)\s+(alerts?|threat)/i],
    domain: 'room', action: 'open', extract: () => ({ target: '/alerts' }),
    preview: () => 'Navigate to Threat Board' },
  { patterns: [/\b(?:open|go\s+to|show)\s+(markets?|operations)/i],
    domain: 'room', action: 'open', extract: () => ({ target: '/markets' }),
    preview: () => 'Navigate to Operations Room' },
  { patterns: [/\b(?:open|go\s+to|show)\s+(buyer|capital)/i],
    domain: 'room', action: 'open', extract: () => ({ target: '/buyer' }),
    preview: () => 'Navigate to Capital Deployment' },
  { patterns: [/\b(?:open|go\s+to|show)\s+(title|closing|execution)/i],
    domain: 'room', action: 'open', extract: () => ({ target: '/title' }),
    preview: () => 'Navigate to Execution Room' },
  { patterns: [/\b(?:open|go\s+to|show)\s+(settings?|config)/i],
    domain: 'room', action: 'open', extract: () => ({ target: '/settings' }),
    preview: () => 'Navigate to Settings' },
  { patterns: [/\b(?:open|go\s+to|show)\s+(home|dashboard|command\s+floor)/i],
    domain: 'room', action: 'open', extract: () => ({ target: '/dashboard/live' }),
    preview: () => 'Navigate to Command Floor' },
  { patterns: [/\b(?:open|go\s+to|show)\s+(intelligence|stats|strategy)/i],
    domain: 'room', action: 'open', extract: () => ({ target: '/stats' }),
    preview: () => 'Navigate to Strategy Room' },
  { patterns: [/\b(?:open|go\s+to|show)\s+(watchlist|tracked)/i],
    domain: 'room', action: 'open', extract: () => ({ target: '/watchlists' }),
    preview: () => 'Navigate to Watchlists' },

  // Map operations
  { patterns: [/\bshow\s+(?:hottest|hot)\s+leads?\s+(?:in\s+)?(\w+)/i],
    domain: 'map', action: 'focus_market',
    extract: (m) => ({ market: m[1] }),
    preview: (p) => `Focus hot leads in ${p.market}` },
  { patterns: [/\bzoom\s+to\s+(.+)/i],
    domain: 'map', action: 'zoom_to',
    extract: (m) => ({ target: m[1].trim() }),
    preview: (p) => `Zoom map to ${p.target}` },
  { patterns: [/\b(?:switch|change|set)\s+map\s+(?:to\s+)?(\w+)\s*(?:mode)?/i],
    domain: 'map', action: 'set_mode',
    extract: (m) => ({ mode: m[1].toLowerCase() }),
    preview: (p) => `Switch map to ${p.mode} mode` },
  { patterns: [/\bshow\s+(heatmap|heat\s+map)/i],
    domain: 'map', action: 'set_mode', extract: () => ({ mode: 'heat' }),
    preview: () => 'Switch map to heatmap mode' },
  { patterns: [/\bshow\s+(pressure|market\s+pressure)/i],
    domain: 'map', action: 'set_mode', extract: () => ({ mode: 'pressure' }),
    preview: () => 'Switch map to pressure mode' },

  // Inbox operations
  { patterns: [/\bdraft\s+(?:a\s+)?repl(?:y|ies?)(?:\s+(.+))?/i],
    domain: 'inbox', action: 'draft_reply',
    extract: (m) => ({ tone: m[1]?.trim() ?? 'professional' }),
    preview: (p) => `Draft reply with ${p.tone} tone` },
  { patterns: [/\bbatch\s+(?:ai\s+)?repl(?:y|ies)/i],
    domain: 'inbox', action: 'batch_reply', extract: () => ({}),
    preview: () => 'Batch review AI draft replies' },

  // Alerts operations
  { patterns: [/\bsummarize\s+alerts?/i],
    domain: 'alerts', action: 'summarize', extract: () => ({}),
    preview: () => 'Summarize active alerts' },
  { patterns: [/\backnowledge\s+(?:all\s+)?(?:critical|p0)\s*(?:alerts?)?/i],
    domain: 'alerts', action: 'ack_critical', extract: () => ({}),
    preview: () => 'Acknowledge critical alerts' },

  // Markets
  { patterns: [/\bfocus\s+(\w+)(?:\s+market)?/i],
    domain: 'markets', action: 'focus',
    extract: (m) => ({ market: m[1] }),
    preview: (p) => `Focus on ${p.market} market` },

  // Buyers
  { patterns: [/\bshow\s+(?:buyer\s+)?match(?:es)?\s+(?:for\s+)?(.+)/i],
    domain: 'buyers', action: 'show_matches',
    extract: (m) => ({ property: m[1].trim() }),
    preview: (p) => `Show buyer matches for ${p.property}` },

  // Title
  { patterns: [/\b(?:focus|show)\s+(?:title\s+)?blockers?/i],
    domain: 'title', action: 'focus_blockers', extract: () => ({}),
    preview: () => 'Focus on title pipeline blockers' },

  // Split view
  { patterns: [/\bopen\s+split\s*(?:view)?/i],
    domain: 'split_view', action: 'open', extract: () => ({}),
    preview: () => 'Open split view panel' },
  { patterns: [/\bopen\s+split\s*(?:view)?\s+(?:for\s+)?(?:current|selected)\s+lead/i],
    domain: 'split_view', action: 'open', extract: () => ({ target: 'current-lead' }),
    preview: () => 'Open split view for current lead' },

  // Briefing
  { patterns: [/\b(?:generate|show|open)\s+briefing/i],
    domain: 'briefing', action: 'generate', extract: () => ({}),
    preview: () => 'Generate operator briefing' },

  // Settings / theme
  { patterns: [/\b(?:change|switch|set)\s+theme\s+(?:to\s+)?([a-z\s-]+)/i],
    domain: 'settings', action: 'set_theme',
    extract: (m) => ({ theme: m[1].trim().toLowerCase().replace(/\s+/g, '-') }),
    preview: (p) => `Change theme to ${p.theme.replace(/-/g, ' ')}` },

  // System queries
  { patterns: [/\bwhat\s+changed\s+(?:in\s+)?(?:the\s+)?(?:last\s+)?(\w+)?/i],
    domain: 'system', action: 'recent_changes',
    extract: (m) => ({ period: m[1] ?? 'hour' }),
    preview: (p) => `Show changes in last ${p.period}` },

  // Watchlist operations
  { patterns: [/\b(?:pin|watch|track)\s+(.+)/i],
    domain: 'watchlist', action: 'pin',
    extract: (m) => ({ target: m[1].trim() }),
    preview: (p) => `Pin ${p.target} to watchlist` },
  { patterns: [/\b(?:open|show)\s+watchlist/i],
    domain: 'room', action: 'open', extract: () => ({ target: '/watchlists' }),
    preview: () => 'Navigate to Watchlists' },

  // Autopilot operations
  { patterns: [/\bpause\s+(?:autopilot|lane)\s*(?:in\s+)?(.+)?/i],
    domain: 'autopilot', action: 'pause_lane',
    extract: (m) => ({ market: m[1]?.trim() ?? 'current' }),
    preview: (p) => `Pause autopilot lane${p.market !== 'current' ? ` in ${p.market}` : ''}` },
  { patterns: [/\bresume\s+(?:autopilot|lane)\s*(?:in\s+)?(.+)?/i],
    domain: 'autopilot', action: 'resume_lane',
    extract: (m) => ({ market: m[1]?.trim() ?? 'current' }),
    preview: (p) => `Resume autopilot lane${p.market !== 'current' ? ` in ${p.market}` : ''}` },
  { patterns: [/\b(?:autopilot|automation)\s+status/i],
    domain: 'autopilot', action: 'status', extract: () => ({}),
    preview: () => 'Show autopilot status' },

  // Notification operations
  { patterns: [/\b(?:open|show)\s+notifications?/i],
    domain: 'room', action: 'open', extract: () => ({ target: '/notifications' }),
    preview: () => 'Navigate to Notifications' },

  // Copilot self-commands
  { patterns: [/\b(?:switch|change)\s+(?:to\s+)?(?:copilot\s+)?(?:sidecar|console|command\s+deck|orb)\s*(?:mode)?/i],
    domain: 'copilot', action: 'switch_mode',
    extract: (m) => {
      const raw = m[0].toLowerCase()
      const mode = raw.includes('console') || raw.includes('command deck') ? 'console' : raw.includes('orb') ? 'orb' : 'sidecar'
      return { mode }
    },
    preview: (p) => `Switch copilot to ${p.mode} mode` },
  { patterns: [/\b(?:switch|enable|set)\s+(?:to\s+)?voice\s+mode/i],
    domain: 'copilot', action: 'voice_mode', extract: () => ({ enabled: 'true' }),
    preview: () => 'Prime voice mode' },
  { patterns: [/\b(?:disable|leave|exit)\s+voice\s+mode/i],
    domain: 'copilot', action: 'voice_mode', extract: () => ({ enabled: 'false' }),
    preview: () => 'Disable voice mode' },
  { patterns: [/\b(?:show|list)\s+commands?|\/help/i],
    domain: 'copilot', action: 'show_help', extract: () => ({}),
    preview: () => 'Show command reference' },

  // Inbox summarize
  { patterns: [/\bsummarize\s+(?:inbox|threads?|messages?)/i],
    domain: 'inbox', action: 'summarize', extract: () => ({}),
    preview: () => 'Summarize inbox threads' },

  // Recent / status
  { patterns: [/\b(?:system\s+)?status/i],
    domain: 'system', action: 'status', extract: () => ({}),
    preview: () => 'Show system status' },
]

export function parseIntent(input: string): ResolvedIntent | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  for (const rule of INTENT_RULES) {
    for (const pattern of rule.patterns) {
      const match = trimmed.match(pattern)
      if (match) {
        const params = rule.extract?.(match) ?? {}
        return {
          domain: rule.domain,
          action: rule.action,
          params,
          raw: trimmed,
          confidence: 90 + Math.random() * 8, // simulated
          preview: rule.preview(params),
        }
      }
    }
  }

  // Fallback — treat as general query
  return {
    domain: 'system',
    action: 'query',
    params: { query: trimmed },
    raw: trimmed,
    confidence: 60 + Math.random() * 15,
    preview: `Query: "${trimmed}"`,
  }
}

// ── Slash Commands ────────────────────────────────────────────────────────

export interface SlashCommand {
  command: string
  label: string
  description: string
  category: string
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { command: '/go',       label: 'Navigate',        description: 'Open a room or surface',        category: 'Navigation' },
  { command: '/focus',    label: 'Focus',            description: 'Focus on a market or entity',   category: 'Navigation' },
  { command: '/zoom',     label: 'Zoom',             description: 'Zoom map to location',          category: 'Map' },
  { command: '/mode',     label: 'Map Mode',         description: 'Switch map visualization',      category: 'Map' },
  { command: '/draft',    label: 'Draft Reply',      description: 'Draft an AI reply',             category: 'Inbox' },
  { command: '/batch',    label: 'Batch Reply',      description: 'Review batch AI drafts',        category: 'Inbox' },
  { command: '/alerts',   label: 'Alerts',           description: 'Summarize or manage alerts',    category: 'Alerts' },
  { command: '/buyers',   label: 'Buyer Matches',    description: 'Show buyer intelligence',       category: 'Buyers' },
  { command: '/briefing', label: 'Briefing',         description: 'Generate operator briefing',    category: 'AI' },
  { command: '/status',   label: 'System Status',    description: 'Show system health',            category: 'System' },
  { command: '/recent',   label: 'Recent Changes',   description: 'What changed recently',         category: 'System' },
  { command: '/split',    label: 'Split View',       description: 'Open or toggle split view',     category: 'Interface' },
  { command: '/help',     label: 'Command Help',     description: 'Show available commands',       category: 'System' },
]

export function matchSlashCommands(query: string): SlashCommand[] {
  if (!query.startsWith('/')) return []
  const q = query.toLowerCase()
  return SLASH_COMMANDS.filter(c => c.command.startsWith(q) || c.label.toLowerCase().includes(q.slice(1)))
}

// ── Room-Aware Suggestions ────────────────────────────────────────────────

export interface CopilotSuggestion {
  id: string
  type: 'action' | 'insight' | 'warning' | 'brief'
  title: string
  detail: string
  confidence: number
  intentDomain?: IntentDomain
  intentAction?: IntentAction
  actionId?: string
  actionLabel?: string
  command?: string
}

export function generateRoomSuggestions(roomPath: string, context?: {
  hotCount?: number; alertCount?: number; pendingActions?: number
}): CopilotSuggestion[] {
  const suggestions: CopilotSuggestion[] = []
  const hot = context?.hotCount ?? 0
  const alerts = context?.alertCount ?? 0
  const pending = context?.pendingActions ?? 0

  switch (roomPath) {
    case '/dashboard/live':
      suggestions.push({
        id: 'brief-home', type: 'brief', title: 'Command Floor Briefing',
        detail: `${hot} hot leads require attention. ${alerts} alerts active. ${pending} autopilot actions pending.`,
        confidence: 95,
      })
      if (hot > 0) suggestions.push({
        id: 'act-hot', type: 'action', title: 'Prioritize Hot Leads',
        detail: 'Hot leads are aging. Engage top-urgency leads for maximum conversion.',
        confidence: 88, actionId: 'focus-hot', actionLabel: 'Focus Hot', command: 'show hot leads',
        intentDomain: 'room', intentAction: 'open',
      })
      if (alerts > 3) suggestions.push({
        id: 'warn-alerts', type: 'warning', title: 'Alert Volume Elevated',
        detail: `${alerts} active alerts exceeds the daily average. Review on the Threat Board.`,
        confidence: 92, actionId: 'go-alerts', actionLabel: 'Open Alerts', command: 'open alerts',
        intentDomain: 'room', intentAction: 'open',
      })
      suggestions.push({
        id: 'insight-pipeline', type: 'insight', title: 'Pipeline Velocity',
        detail: 'Pipeline velocity tracking 12% above weekly average. Pressure in Dallas and Phoenix.',
        confidence: 76,
      })
      break

    case '/inbox':
      suggestions.push({
        id: 'brief-inbox', type: 'brief', title: 'Comms Deck Intelligence',
        detail: 'Threads requiring response detected. AI drafts ready for review.',
        confidence: 90,
      })
      suggestions.push({
        id: 'act-batch', type: 'action', title: 'Batch AI Replies',
        detail: 'AI has pre-drafted responses for unread threads. Review and approve.',
        confidence: 82, actionId: 'batch-reply', actionLabel: 'Review Drafts', command: 'batch ai replies',
        intentDomain: 'inbox', intentAction: 'batch_reply',
      })
      suggestions.push({
        id: 'insight-comms', type: 'insight', title: 'Response Pattern',
        detail: 'Reply rates peak 10am–2pm. Scheduling sends in this window increases engagement 23%.',
        confidence: 71,
      })
      break

    case '/alerts':
      suggestions.push({
        id: 'brief-alerts', type: 'brief', title: 'Threat Board Briefing',
        detail: 'Active alerts span multiple markets. P0 items need acknowledgment.',
        confidence: 94,
      })
      suggestions.push({
        id: 'act-ack', type: 'action', title: 'Acknowledge Critical',
        detail: 'Unacknowledged P0 alerts degrade system health. Clear highest-severity first.',
        confidence: 90, actionId: 'ack-alerts', actionLabel: 'Review P0', command: 'acknowledge critical alerts',
        intentDomain: 'alerts', intentAction: 'ack_critical',
      })
      break

    case '/markets':
      suggestions.push({
        id: 'brief-markets', type: 'brief', title: 'Operations Intelligence',
        detail: 'Market coverage nominal. Delivery rates stable. Phoenix showing accelerating pressure.',
        confidence: 87,
      })
      suggestions.push({
        id: 'act-pressure', type: 'action', title: 'Pressure Analysis',
        detail: 'Switch to pressure mode to visualize market heat distribution.',
        confidence: 78, actionId: 'map-pressure', actionLabel: 'Pressure Mode', command: 'switch map to pressure',
        intentDomain: 'map', intentAction: 'set_mode',
      })
      break

    case '/buyer':
      suggestions.push({
        id: 'brief-buyer', type: 'brief', title: 'Capital Deployment Brief',
        detail: 'Active buyer pool healthy. Match quality averaging 78%. Pre-approved: 62%.',
        confidence: 83,
      })
      break

    case '/title':
      suggestions.push({
        id: 'brief-title', type: 'brief', title: 'Execution Status',
        detail: 'Title pipeline normal. No critical blockers. Days-in-phase within range.',
        confidence: 89,
      })
      suggestions.push({
        id: 'act-blockers', type: 'action', title: 'Surface Blockers',
        detail: 'Review any items stalled in title or closing phases.',
        confidence: 80, actionId: 'title-blockers', actionLabel: 'Show Blockers', command: 'show title blockers',
        intentDomain: 'title', intentAction: 'focus_blockers',
      })
      break

    case '/settings':
      suggestions.push({
        id: 'brief-settings', type: 'brief', title: 'Configuration Summary',
        detail: 'Current theme, sound profile, and copilot settings loaded. Adjust as needed.',
        confidence: 85,
      })
      break

    default:
      suggestions.push({
        id: 'brief-gen', type: 'brief', title: 'NEXUS Intelligence',
        detail: 'System operating normally. No anomalies detected across active markets.',
        confidence: 85,
      })
      break
  }
  return suggestions
}

// ── Greeting Builder ──────────────────────────────────────────────────────

export function getTimeGreeting(): string {
  const h = new Date().getHours()
  if (h < 5) return 'Late night session'
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  if (h < 21) return 'Good evening'
  return 'Late session'
}

export function buildGreeting(operatorName: string, style: string, roomPath: string, context?: {
  hotCount?: number; alertCount?: number; pendingActions?: number
}, personalization?: {
  operatorTitle?: string
  assistantName?: string
}): string[] {
  const resolvedName = operatorName?.trim() || 'Operator'
  const resolvedTitle = personalization?.operatorTitle?.trim() || 'Operator'
  const assistantName = personalization?.assistantName?.trim() || 'NEXUS'
  const displayName = operatorName?.trim() ? `${resolvedTitle} ${resolvedName}` : resolvedTitle
  const room = resolveRoom(roomPath)
  const lines: string[] = []

  switch (style) {
    case 'cinematic':
      lines.push(`${getTimeGreeting()}, ${displayName}.`)
      lines.push(`${assistantName} has synchronized ${room.room}.`)
      if (context?.hotCount && context.hotCount > 0) lines.push(`${context.hotCount} live targets require immediate attention.`)
      if (context?.alertCount && context.alertCount > 0) lines.push(`${context.alertCount} active signals are flowing through the threat lattice.`)
      if (context?.pendingActions && context.pendingActions > 0) lines.push(`${context.pendingActions} staged actions are awaiting operator judgment.`)
      break
    case 'casual':
      lines.push(`Welcome back, ${resolvedName}. ${assistantName} is live in ${room.room}.`)
      if (context?.hotCount && context.hotCount > 0) lines.push(`${context.hotCount} hot leads are ready for a closer look.`)
      break
    case 'minimal':
      lines.push(`${assistantName} online.`)
      lines.push(`${room.room} synced.`)
      break
    default: // formal
      lines.push(`${getTimeGreeting()}, ${displayName}.`)
      lines.push(`${assistantName} has established a private intelligence channel in ${room.room}.`)
      if (context?.hotCount && context.hotCount > 0) lines.push(`${context.hotCount} hot lead${context.hotCount > 1 ? 's' : ''} are inside the active decision band.`)
      if (context?.alertCount && context.alertCount > 0) lines.push(`${context.alertCount} live alert${context.alertCount > 1 ? 's' : ''} are available for review.`)
      if (context?.pendingActions && context.pendingActions > 0) lines.push(`${context.pendingActions} staged automation action${context.pendingActions > 1 ? 's' : ''} are pending your approval.`)
      break
  }

  return lines
}

// ── Mission Trace Events ──────────────────────────────────────────────────

export type TraceEventType =
  | 'context' | 'parse' | 'search' | 'analysis'
  | 'draft' | 'execution' | 'completion' | 'error'
  | 'voice' | 'greeting' | 'confirmation' | 'system'

export interface TraceEvent {
  id: string
  ts: number
  type: TraceEventType
  label: string
  detail?: string
  room?: string
  contextLabel?: string
  state?: CopilotState
  pinned?: boolean
}

let _traceCounter = 0

export function createTraceEvent(type: TraceEventType, label: string, detail?: string, room?: string, state?: CopilotState): TraceEvent {
  const resolved = room ? resolveRoom(room) : null
  return {
    id: `trace-${++_traceCounter}-${Date.now()}`,
    ts: Date.now(),
    type,
    label,
    detail,
    room,
    contextLabel: resolved?.room,
    state,
  }
}

// ── Model Options ─────────────────────────────────────────────────────────

export interface ModelOption {
  id: string
  label: string
  description: string
  speed: 'fast' | 'balanced' | 'thorough'
}

export const MODEL_OPTIONS: ModelOption[] = [
  { id: 'nexus-fast',      label: 'NEXUS Fast',      description: 'Quick responses, lower depth',    speed: 'fast' },
  { id: 'nexus-balanced',  label: 'NEXUS Balanced',  description: 'Default intelligence depth',      speed: 'balanced' },
  { id: 'nexus-deep',      label: 'NEXUS Deep',      description: 'Maximum reasoning, slower',       speed: 'thorough' },
]

// ── Conversation Messages ─────────────────────────────────────────────────

export type MessageRole = 'operator' | 'copilot' | 'system'

export interface ConversationMessage {
  id: string
  role: MessageRole
  text: string
  ts: number
  state?: CopilotState
  intent?: string
}

let _msgCounter = 0

export function createMessage(role: MessageRole, text: string, state?: CopilotState, intent?: string): ConversationMessage {
  return {
    id: `msg-${++_msgCounter}-${Date.now()}`,
    role,
    text,
    ts: Date.now(),
    state,
    intent,
  }
}

// ── Quick Actions ─────────────────────────────────────────────────────────

export interface QuickAction {
  id: string
  label: string
  icon: string
  subtitle?: string
  tone?: 'focus' | 'action' | 'warning' | 'brief'
  hotkey?: string
  intent: ResolvedIntent
}

export function generateQuickActions(roomPath: string): QuickAction[] {
  switch (roomPath) {
    case '/dashboard/live':
      return [
        { id: 'qa-briefing', label: 'Briefing', subtitle: 'Generate operator digest', icon: '◉', tone: 'brief', hotkey: '⌘.', intent: { domain: 'briefing', action: 'generate', params: {}, raw: 'generate briefing', confidence: 95, preview: 'Generate operator briefing' } },
        { id: 'qa-hot', label: 'Hot Leads', subtitle: 'Focus highest urgency targets', icon: '⦿', tone: 'focus', hotkey: 'H', intent: { domain: 'map', action: 'focus_market', params: { market: 'hot' }, raw: 'show hot leads', confidence: 90, preview: 'Focus hot leads on map' } },
        { id: 'qa-pressure', label: 'Pressure', subtitle: 'Shift map to pressure mode', icon: '◎', tone: 'action', hotkey: 'P', intent: { domain: 'map', action: 'set_mode', params: { mode: 'pressure' }, raw: 'switch map to pressure', confidence: 92, preview: 'Switch to pressure mode' } },
        { id: 'qa-alerts', label: 'Threats', subtitle: 'Open critical alert board', icon: '⚡', tone: 'warning', hotkey: 'A', intent: { domain: 'room', action: 'open', params: { target: '/alerts' }, raw: 'open alerts', confidence: 95, preview: 'Navigate to Threat Board' } },
      ]
    case '/inbox':
      return [
        { id: 'qa-batch', label: 'Batch Reply', subtitle: 'Review AI draft queue', icon: '✎', tone: 'action', hotkey: 'B', intent: { domain: 'inbox', action: 'batch_reply', params: {}, raw: 'batch reply', confidence: 88, preview: 'Batch review AI draft replies' } },
        { id: 'qa-draft', label: 'Draft Reply', subtitle: 'Compose a warmer response', icon: '◈', tone: 'focus', hotkey: 'D', intent: { domain: 'inbox', action: 'draft_reply', params: { tone: 'professional' }, raw: 'draft reply', confidence: 85, preview: 'Draft professional reply' } },
        { id: 'qa-summarize', label: 'Summarize', subtitle: 'Summarize unread threads', icon: '◉', tone: 'brief', hotkey: 'S', intent: { domain: 'inbox', action: 'summarize', params: {}, raw: 'summarize inbox', confidence: 82, preview: 'Summarize unread threads' } },
      ]
    case '/alerts':
      return [
        { id: 'qa-summarize', label: 'Summarize', subtitle: 'Condense active threat stream', icon: '◉', tone: 'brief', hotkey: 'S', intent: { domain: 'alerts', action: 'summarize', params: {}, raw: 'summarize alerts', confidence: 90, preview: 'Summarize active alerts' } },
        { id: 'qa-ack', label: 'Ack Critical', subtitle: 'Review and clear P0 alerts', icon: '⚠', tone: 'warning', hotkey: 'C', intent: { domain: 'alerts', action: 'ack_critical', params: {}, raw: 'acknowledge critical', confidence: 88, preview: 'Acknowledge critical alerts' } },
      ]
    case '/markets':
      return [
        { id: 'qa-pressure', label: 'Pressure', subtitle: 'Reveal stress concentrations', icon: '◎', tone: 'focus', hotkey: 'P', intent: { domain: 'map', action: 'set_mode', params: { mode: 'pressure' }, raw: 'show pressure', confidence: 90, preview: 'Switch to pressure mode' } },
        { id: 'qa-heat', label: 'Heatmap', subtitle: 'Shift to thermal signal view', icon: '⦿', tone: 'focus', hotkey: 'H', intent: { domain: 'map', action: 'set_mode', params: { mode: 'heat' }, raw: 'show heat', confidence: 88, preview: 'Switch to heatmap mode' } },
      ]
    case '/buyer':
      return [
        { id: 'qa-matches', label: 'Best Matches', subtitle: 'Surface capital matches', icon: '⟡', tone: 'action', hotkey: 'M', intent: { domain: 'buyers', action: 'show_matches', params: { property: 'current' }, raw: 'show best buyer matches', confidence: 85, preview: 'Show best buyer matches' } },
      ]
    case '/title':
      return [
        { id: 'qa-blockers', label: 'Blockers', subtitle: 'Surface execution friction', icon: '⚠', tone: 'warning', hotkey: 'B', intent: { domain: 'title', action: 'focus_blockers', params: {}, raw: 'show blockers', confidence: 88, preview: 'Focus on title blockers' } },
      ]
    default:
      return [
        { id: 'qa-home', label: 'Command Floor', subtitle: 'Return to command floor', icon: '◈', tone: 'brief', hotkey: 'H', intent: { domain: 'room', action: 'open', params: { target: '/dashboard/live' }, raw: 'go home', confidence: 95, preview: 'Navigate to Command Floor' } },
      ]
  }
}

// ── Plan Decomposition ────────────────────────────────────────────────────

export interface PlanStep {
  id: string
  label: string
  status: 'pending' | 'active' | 'done' | 'error'
  detail?: string
}

export function decomposePlan(intent: ResolvedIntent): PlanStep[] {
  const steps: PlanStep[] = [
    { id: 'step-parse', label: 'Parse intent', status: 'done' },
    { id: 'step-resolve', label: `Resolve ${intent.domain}.${intent.action}`, status: 'done' },
  ]
  if (intent.domain === 'room') {
    steps.push({ id: 'step-nav', label: `Navigate to ${intent.params.target ?? intent.preview}`, status: 'pending' })
  } else if (intent.domain === 'map') {
    steps.push({ id: 'step-map', label: `Apply map: ${intent.action}`, status: 'pending' })
  } else if (intent.domain === 'inbox') {
    steps.push({ id: 'step-inbox-nav', label: 'Switch to Comms Deck', status: 'pending' })
    steps.push({ id: 'step-inbox-act', label: intent.preview, status: 'pending' })
  } else if (intent.domain === 'briefing') {
    steps.push({ id: 'step-gather', label: 'Gather intelligence data', status: 'pending' })
    steps.push({ id: 'step-gen', label: 'Generate briefing digest', status: 'pending' })
    steps.push({ id: 'step-present', label: 'Present briefing panel', status: 'pending' })
  } else {
    steps.push({ id: 'step-exec', label: intent.preview, status: 'pending' })
  }
  steps.push({ id: 'step-complete', label: 'Confirm completion', status: 'pending' })
  return steps
}

// ── State Transition Metadata ─────────────────────────────────────────────

export const STATE_FLOW: Record<string, CopilotState[]> = {
  'text-command': ['understanding', 'searching', 'analyzing', 'planning', 'executing', 'completed'],
  'voice-command': ['listening', 'transcribing', 'understanding', 'analyzing', 'planning', 'executing', 'completed'],
  'room-change': ['analyzing', 'completed'],
  'suggestion-action': ['executing', 'completed'],
  'greeting': ['greeting', 'speaking', 'idle'],
}

// ── Command Grammar Reference ─────────────────────────────────────────────

export interface CommandGrammarEntry {
  category: string
  examples: string[]
}

export const COMMAND_GRAMMAR: CommandGrammarEntry[] = [
  { category: 'Navigation', examples: ['open inbox', 'go to alerts', 'show markets', 'go home'] },
  { category: 'Map Controls', examples: ['switch map to pressure', 'show heatmap', 'zoom to Dallas', 'show hot leads in Houston'] },
  { category: 'Inbox', examples: ['draft reply warmer tone', 'batch ai replies', 'summarize inbox'] },
  { category: 'Alerts', examples: ['summarize alerts', 'acknowledge critical alerts'] },
  { category: 'Markets', examples: ['focus Phoenix market'] },
  { category: 'Buyers', examples: ['show buyer matches for this property'] },
  { category: 'Title', examples: ['show title blockers', 'focus blockers'] },
  { category: 'Views', examples: ['open split view', 'open split view for current lead'] },
  { category: 'Briefing', examples: ['generate briefing', 'open briefing'] },
  { category: 'Copilot', examples: ['switch to command deck mode', 'switch to voice mode', '/help'] },
  { category: 'Settings', examples: ['change theme to infrared', 'change theme to dark matter'] },
  { category: 'System', examples: ['what changed in the last hour', 'system status'] },
]
