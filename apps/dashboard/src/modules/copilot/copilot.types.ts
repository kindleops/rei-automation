export interface CopilotAgent {
  id: string;
  name: string;
  role: string;
  personality: string;
  avatarEmoji: string;
  accentColor: string;
  responseStyle: string;
  specialties: string[];
  actionPermissions: ('read' | 'mutate' | 'dangerous')[];
  riskLimits: string;
  suggestedPrompts: string[];
  thinkingPhrases: string[];
}

export type CopilotActionStatus = 'pending' | 'success' | 'error';
export type ActionSeverity = 'safe' | 'warning' | 'dangerous';

export interface CopilotActionPreviewData {
  id: string;
  title: string;
  description: string;
  severity: ActionSeverity;
  payload: any;
  status?: CopilotActionStatus;
}

export interface ThinkingStep {
  label: string;
  status: 'pending' | 'active' | 'done' | 'error';
}

export interface ReasoningContext {
  contextLoaded: string[];
  toolsConsidered: string[];
  safetyChecks: string[];
  dataReads: string[];
  proposedMutations: string[];
  finalPlan: string;
}

export interface ChatMessage {
  id: string;
  role: 'agent' | 'operator' | 'system';
  agentId: string;
  body: string;
  timestamp: string;
  status?: 'thinking' | 'streaming' | 'complete' | 'error';
  thinkingSteps?: ThinkingStep[];
  reasoning?: ReasoningContext;
  actionPreview?: CopilotActionPreviewData;
  underwritingData?: any;
  sentiment?: 'hot' | 'warm' | 'cold' | 'neutral';
  confidenceScore?: number;
  handoffAgentId?: string;
  collaborationEvent?: { title: string; description: string };
}
