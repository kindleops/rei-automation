import { Icon } from '../../../shared/icons';

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ');

export const SentimentTracker = ({ sentiment }: { sentiment: 'hot' | 'warm' | 'cold' | 'neutral' }) => {
  const map = {
    hot: { icon: 'trending-up', label: 'HOT', color: '#ff453a', bg: 'rgba(255, 69, 58, 0.2)' },
    warm: { icon: 'activity', label: 'WARM', color: '#ff9f0a', bg: 'rgba(255, 159, 10, 0.2)' },
    cold: { icon: 'archive', label: 'COLD', color: '#64d2ff', bg: 'rgba(100, 210, 255, 0.2)' },
    neutral: { icon: 'minus', label: 'NEUTRAL', color: '#a0aec0', bg: 'rgba(255, 255, 255, 0.1)' }
  };

  const config = map[sentiment] || map.neutral;

  return (
    <div className="nx-copilot-sentiment-badge" style={{ color: config.color, background: config.bg }}>
      <Icon name={config.icon as any} />
      <span>{config.label}</span>
    </div>
  );
};

export const ConfidenceVisualizer = ({ score, label }: { score: number, label?: string }) => {
  const isHigh = score >= 80;
  const isMedium = score >= 50 && score < 80;
  const isLow = score < 50;

  return (
    <div className="nx-copilot-confidence">
      {label && <span className="nx-conf-label">{label}</span>}
      <div className="nx-conf-bar-bg">
        <div 
          className={cls('nx-conf-bar-fill', isHigh && 'is-high', isMedium && 'is-medium', isLow && 'is-low')}
          style={{ width: `${Math.max(0, Math.min(100, score))}%` }}
        />
      </div>
      <span className="nx-conf-score">{score}%</span>
    </div>
  );
};
