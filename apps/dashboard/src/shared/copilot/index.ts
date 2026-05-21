export { CopilotShell } from './CopilotShell'
export type { CopilotContext } from './copilot-state'
export type {
  CopilotMode, CopilotState, ResolvedIntent, ActionPermission, TraceEvent,
  ConversationMessage, QuickAction, PlanStep, CommandGrammarEntry,
} from './copilot-state'
export {
  parseIntent, resolveRoom, buildGreeting, createMessage,
  generateQuickActions, decomposePlan, SLASH_COMMANDS, MODEL_OPTIONS,
  COMMAND_GRAMMAR, STATE_FLOW,
} from './copilot-state'
