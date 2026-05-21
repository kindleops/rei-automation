export type NexusCoreState =
  | 'idle'
  | 'reply'
  | 'classify'
  | 'sending'
  | 'underwriting'
  | 'hot_lead'
  | 'critical';

export interface OrbActivityMetrics {
  queueSendsPerMin: number;
  repliesPerMin: number;
  classificationsPerMin: number;
  activeUnderwritingJobs: number;
  hotLeadCount: number;
  automationExecutionCount: number;
  heatIndex: number; // 0.0 to 1.0
}

export interface OrbStateConfig {
  label: string;
  color: string;
  pulseSpeed: number;
  glowIntensity: number;
  ringSpeed: number;
  particleDensity: number;
  scale: number;
}
