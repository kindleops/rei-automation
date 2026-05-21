import { useState, useMemo, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useNexusActivity } from '../hooks/useNexusActivity';
import { ORB_STATES } from './orb-state-machine';
import { NexusCorePanel } from './NexusCorePanel';
import './nexus-core-orb.css';

// Support the CopilotOrb interface for drop-in replacement
interface NexusCoreOrbProps {
  state?: string; // copilot state
  amplitude?: number;
  onClick?: () => void;
  onPushToTalk?: () => void;
  onPushToTalkRelease?: () => void;
  className?: string;
  textOverlay?: string | null;
  textInterim?: boolean;
}

export function NexusCoreOrb({ 
  state: copilotState = 'idle', 
  amplitude = 0, 
  onClick, 
  onPushToTalk, 
  onPushToTalkRelease,
  className,
  textOverlay,
  textInterim
}: NexusCoreOrbProps) {
  const { metrics, activeState: systemState, heat } = useNexusActivity();
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  
  // Merge system state and copilot state
  // Copilot state takes visual precedence for color/pulse
  const activeState = useMemo(() => {
    if (copilotState === 'listening' || copilotState === 'thinking') return 'classify';
    if (copilotState === 'speaking') return 'reply';
    if (copilotState === 'error') return 'critical';
    return systemState;
  }, [copilotState, systemState]);

  const config = useMemo(() => {
    const base = ORB_STATES[activeState];
    
    return {
      ...base,
      pulseSpeed: base.pulseSpeed / (1 + heat * 2 + amplitude * 3),
      glowIntensity: base.glowIntensity + (heat * 0.5) + amplitude,
      ringSpeed: base.ringSpeed * (1 + heat * 3 + amplitude * 5),
      scale: base.scale * (1 + heat * 0.1 + amplitude * 0.2),
    };
  }, [activeState, heat, amplitude]);

  const handleClick = () => {
    if (onClick) onClick();
    setIsPanelOpen(true);
  };

  return (
    <>
      <motion.div 
        className={`nexus-orb-container ${className || ''}`}
        onClick={handleClick}
        onMouseDown={onPushToTalk}
        onMouseUp={onPushToTalkRelease}
        onMouseLeave={onPushToTalkRelease}
        animate={{ scale: config.scale }}
        whileTap={{ scale: 0.95 }}
        style={{ 
          ['--orb-color' as any]: config.color,
          ['--orb-color-alpha' as any]: `color-mix(in srgb, ${config.color}, transparent 70%)`
        }}
      >
        <div className="nexus-orb-canvas">
          {/* Layer 1: Dynamic Glow Field */}
          <motion.div 
            className="orb-glow-field"
            animate={{ 
              opacity: [0.3, 0.6 + amplitude, 0.3],
              scale: [1, 1.1 + amplitude * 0.5, 1]
            }}
            transition={{ 
              duration: config.pulseSpeed * 2, 
              repeat: Infinity,
              ease: "easeInOut" 
            }}
          />

          {/* Layer 2: Pulse Halo */}
          <motion.div 
            className="orb-halo"
            animate={{ 
              scale: [1, 1.05 + amplitude * 0.2, 1],
              opacity: [0.2, 0.4 + amplitude, 0.2]
            }}
            transition={{ 
              duration: config.pulseSpeed, 
              repeat: Infinity,
              ease: "easeInOut" 
            }}
          />

          {/* Layer 3: Rotating Outer Rings */}
          <div className="orb-rings-container">
            <svg viewBox="0 0 100 100" className="orb-ring-svg">
              <motion.circle
                cx="50" cy="50" r="48"
                className="orb-ring"
                strokeDasharray="20 150"
                animate={{ rotate: 360 }}
                transition={{ duration: 8 / config.ringSpeed, repeat: Infinity, ease: "linear" }}
              />
              <motion.circle
                cx="50" cy="50" r="42"
                className="orb-ring"
                strokeDasharray="5 15"
                animate={{ rotate: -360 }}
                transition={{ duration: 12 / config.ringSpeed, repeat: Infinity, ease: "linear" }}
              />
              <motion.circle
                cx="50" cy="50" r="36"
                className="orb-ring"
                strokeDasharray="2 8"
                animate={{ rotate: 360 }}
                transition={{ duration: 18 / config.ringSpeed, repeat: Infinity, ease: "linear" }}
              />
            </svg>
          </div>

          {/* Layer 4: Inner Core */}
          <div className="orb-core-container">
            <motion.div 
              className="orb-core-outer"
              animate={{ scale: [1, 1.3 + amplitude * 1, 1] }}
              transition={{ duration: config.pulseSpeed, repeat: Infinity, ease: "easeInOut" }}
            />
            <motion.div 
              className="orb-core-inner"
              animate={{ 
                boxShadow: [
                  `0 0 15px 2px white, 0 0 30px 5px ${config.color}`,
                  `0 0 ${25 + amplitude * 20}px 5px white, 0 0 ${50 + amplitude * 40}px 15px ${config.color}`,
                  `0 0 15px 2px white, 0 0 30px 5px ${config.color}`
                ]
              }}
              transition={{ duration: config.pulseSpeed, repeat: Infinity, ease: "easeInOut" }}
            />
          </div>

          {/* Layer 5: High-Performance Canvas Particles */}
          <CanvasParticles speed={config.ringSpeed} color={config.color} density={config.particleDensity} />

          {/* Voice Feedback Overlay */}
          <AnimatePresence>
            {textOverlay && (
              <motion.div 
                initial={{ opacity: 0, y: 10, scale: 0.9 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -10, scale: 0.9 }}
                style={{
                  position: 'absolute', bottom: '130%', whiteSpace: 'nowrap',
                  background: 'rgba(10, 15, 25, 0.9)', padding: '0.75rem 1.25rem', borderRadius: '16px',
                  fontSize: '0.85rem', fontWeight: 600, border: '1px solid rgba(255,255,255,0.1)',
                  color: textInterim ? 'rgba(255,255,255,0.5)' : 'white',
                  boxShadow: '0 10px 30px rgba(0,0,0,0.5)', backdropFilter: 'blur(10px)',
                  zIndex: 100, pointerEvents: 'none'
                }}
              >
                {textOverlay}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>

      <AnimatePresence>
        {isPanelOpen && (
          <NexusCorePanel 
            metrics={metrics} 
            activeState={activeState} 
            onClose={() => setIsPanelOpen(false)} 
          />
        )}
      </AnimatePresence>
    </>
  );
}

function CanvasParticles({ speed, color, density }: { speed: number, color: string, density: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const particles = useRef<any[]>([]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrameId: number;

    const createParticle = () => ({
      x: canvas.width / 2,
      y: canvas.height / 2,
      angle: Math.random() * Math.PI * 2,
      distance: 20 + Math.random() * 10,
      speed: (0.5 + Math.random() * 2) * (speed * 0.5),
      size: 0.5 + Math.random() * 1.5,
      opacity: 1,
      life: 1.0
    });

    const render = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      
      // Add new particles if needed
      if (particles.current.length < density * 2) {
        particles.current.push(createParticle());
      }

      particles.current.forEach((p: any) => {
        p.distance += p.speed;
        p.life -= 0.01 * (1 / speed);
        p.opacity = p.life;

        const x = canvas.width / 2 + Math.cos(p.angle) * p.distance;
        const y = canvas.height / 2 + Math.sin(p.angle) * p.distance;

        ctx.beginPath();
        ctx.arc(x, y, p.size, 0, Math.PI * 2);
        ctx.fillStyle = color.replace('var(--nx-cyan)', '#00f2ff').replace('var(--nx-gold)', '#ffc800'); // Simple hex fallback
        ctx.globalAlpha = p.opacity;
        ctx.fill();

        if (p.life <= 0 || p.distance > canvas.width / 2) {
          const index = particles.current.indexOf(p);
          if (index > -1) particles.current[index] = createParticle();
        }
      });

      animationFrameId = requestAnimationFrame(render);
    };

    render();
    return () => cancelAnimationFrame(animationFrameId);
  }, [speed, color, density]);

  return (
    <canvas 
      ref={canvasRef} 
      width={200} 
      height={200} 
      style={{ 
        position: 'absolute', width: '250%', height: '250%', 
        pointerEvents: 'none', zIndex: 6, mixBlendMode: 'screen' 
      }} 
    />
  );
}

