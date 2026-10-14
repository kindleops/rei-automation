import type { CopilotAgent } from './copilot.types';

/**
 * The status shown while a request is in flight. It used to rotate scripted
 * phrases ("Analyzing workflow bottlenecks…") every 2.5 s, unrelated to any
 * server event; it is now a plain, true "Working…".
 */
export const useThinkingRotation = (_agent: CopilotAgent, _isThinking: boolean) => 'Working…';
