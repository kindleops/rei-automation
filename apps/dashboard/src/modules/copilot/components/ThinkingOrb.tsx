const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ');

interface ThinkingOrbProps {
  state: 'idle' | 'listening' | 'analyzing' | 'speaking';
  amplitude: number;
  size?: 'sm' | 'md' | 'lg';
  color?: string;
  onClick?: () => void;
}

export const ThinkingOrb = ({ state, amplitude, size = 'md', color = '#68d9c4', onClick }: ThinkingOrbProps) => {
  const isThinking = state === 'analyzing';

  return (
    <div 
      className={cls('nx-ai-orb-container', `is-${size}`, isThinking && 'is-thinking')}
      onClick={onClick}
    >
      <div 
        className="nx-ai-orb" 
        style={{ '--orb-color': color, transform: `scale(${1 + amplitude})` } as any}
      >
        <div className="nx-ai-orb-shimmer" />
      </div>
      {isThinking && <div className="nx-ai-orb-halo" style={{ '--orb-color': color } as any} />}
    </div>
  );
};
