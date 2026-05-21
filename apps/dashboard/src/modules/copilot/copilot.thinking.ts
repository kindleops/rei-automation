import { useState, useEffect, useRef } from 'react';
import type { CopilotAgent } from './copilot.types';

export const useThinkingRotation = (agent: CopilotAgent, isThinking: boolean) => {
  const [currentPhrase, setCurrentPhrase] = useState(agent.thinkingPhrases[0]);
  const phraseIndex = useRef(0);

  useEffect(() => {
    if (!isThinking) {
      phraseIndex.current = 0;
      setCurrentPhrase(agent.thinkingPhrases[0]);
      return;
    }

    const interval = setInterval(() => {
      phraseIndex.current = (phraseIndex.current + 1) % agent.thinkingPhrases.length;
      setCurrentPhrase(agent.thinkingPhrases[phraseIndex.current]);
    }, 2500);

    return () => clearInterval(interval);
  }, [isThinking, agent.id, agent.thinkingPhrases]);

  return currentPhrase;
};
