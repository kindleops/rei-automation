import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import type { OrbActivityMetrics, NexusCoreState } from '../types/orb';
import { ORB_STATES } from './orb-state-machine';

interface NexusCorePanelProps {
  metrics: OrbActivityMetrics;
  activeState: NexusCoreState;
  onClose: () => void;
}

export function NexusCorePanel({ metrics, activeState, onClose }: NexusCorePanelProps) {
  const [logs, setLogs] = useState<string[]>([]);
  const stateConfig = ORB_STATES[activeState];

  useEffect(() => {
    if (activeState !== 'idle') {
      const message = `[INTEL] ${stateConfig.label.toUpperCase()} - System engagement surge detected. ${metrics.queueSendsPerMin} tx/min throughput.`;
      setLogs(prev => [message, ...prev].slice(0, 50));
    }
  }, [activeState, stateConfig.label, metrics.queueSendsPerMin]);

  return (
    <motion.div 
      className="nexus-core-panel-overlay"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
    >
      <motion.div 
        className="nexus-core-panel"
        initial={{ scale: 0.9, y: 20, opacity: 0 }}
        animate={{ scale: 1, y: 0, opacity: 1 }}
        exit={{ scale: 0.9, y: 20, opacity: 0 }}
        transition={{ type: "spring", damping: 30, stiffness: 400 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel-header">
          <div>
            <h2 style={{ margin: 0, fontSize: '2rem', fontWeight: 800, letterSpacing: '-0.02em', background: 'linear-gradient(to bottom, #fff, #999)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
              NEXUS CORE
            </h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginTop: '0.5rem' }}>
              <motion.div 
                animate={{ opacity: [1, 0.4, 1] }}
                transition={{ duration: 1, repeat: Infinity }}
                style={{ 
                  width: 10, height: 10, borderRadius: '50%', backgroundColor: stateConfig.color,
                  boxShadow: `0 0 15px ${stateConfig.color}`
                }} 
              />
              <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'rgba(255,255,255,0.6)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                Mode: {stateConfig.label}
              </span>
            </div>
          </div>
          <button onClick={onClose} style={{ 
            background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', 
            color: 'white', cursor: 'pointer', padding: '0.5rem 1rem', borderRadius: '12px',
            fontSize: '0.7rem', fontWeight: 600, transition: 'all 0.2s'
          }} onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.1)'}
             onMouseLeave={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.05)'}>
            CLOSE TERMINAL
          </button>
        </div>

        <div className="panel-grid">
          <MetricCard label="Outbound Velocity" value={metrics.queueSendsPerMin} suffix="tx/m" />
          <MetricCard label="Inbound Signal" value={metrics.repliesPerMin} suffix="msg/m" />
          <MetricCard label="AI Classifications" value={metrics.classificationsPerMin} suffix="ops" />
          <MetricCard label="Active Underwriting" value={metrics.activeUnderwritingJobs} suffix="jobs" />
          <MetricCard label="Hot Leads" value={metrics.hotLeadCount} suffix="active" color="var(--nx-gold)" />
          <MetricCard label="Core Temperature" value={(metrics.heatIndex * 100).toFixed(1)} suffix="%" color={metrics.heatIndex > 0.8 ? 'var(--nx-red)' : 'var(--nx-cyan)'} />

          <div className="live-feed-container">
            <div style={{ marginBottom: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '0.7rem', fontWeight: 700, color: 'rgba(255,255,255,0.3)', textTransform: 'uppercase', letterSpacing: '0.2em' }}>
                SYSTEM ACTIVITY STREAM
              </span>
              <span style={{ fontSize: '0.6rem', color: 'var(--nx-cyan)', opacity: 0.8, fontFamily: 'monospace' }}>
                LIVE // ENCRYPTED_CHANNEL_01
              </span>
            </div>
            <div className="live-feed">
              {logs.length === 0 ? (
                <div style={{ opacity: 0.2, height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.8rem' }}>
                  AWAITING SYSTEM ENGAGEMENT...
                </div>
              ) : (
                logs.map((log, i) => (
                  <div key={i} className="feed-item">
                    <span style={{ color: 'rgba(255,255,255,0.2)', minWidth: '85px' }}>[{new Date().toLocaleTimeString()}]</span>
                    <span style={{ color: log.includes('HOT LEAD') ? 'var(--nx-gold)' : 'inherit' }}>{log}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        <div style={{ marginTop: '2.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', opacity: 0.3, fontSize: '0.65rem', fontWeight: 600, letterSpacing: '0.1em' }}>
          <div style={{ display: 'flex', gap: '2rem' }}>
            <span>NEXUS-OS // KERNEL v4.0.2</span>
            <span>UPLINK: ACTIVE</span>
            <span>LATENCY: 12ms</span>
          </div>
          <span>SECURE OPERATOR SESSION</span>
        </div>
      </motion.div>
    </motion.div>
  );
}

function MetricCard({ label, value, suffix, color }: { label: string; value: string | number; suffix?: string; color?: string }) {
  return (
    <div className="panel-card">
      <span className="card-label">{label}</span>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.4rem' }}>
        <span className="card-value" style={{ 
          background: color ? `linear-gradient(to right, #fff, ${color})` : undefined,
          WebkitBackgroundClip: color ? 'text' : undefined,
          WebkitTextFillColor: color ? 'transparent' : undefined
        }}>
          {value}
        </span>
        {suffix && <span style={{ fontSize: '0.8rem', fontWeight: 600, opacity: 0.4 }}>{suffix}</span>}
      </div>
    </div>
  );
}
