import { useEffect } from 'react'
import { motion, useSpring, useTransform } from 'framer-motion'
import { LC_SPRING, useLcReducedMotion } from '../../../shared/lc'

/**
 * A figure that glides to its next value when the evidence changes (§138) —
 * a short spring on the number itself, not a rolling counter. First paint
 * shows the value as is; reduced motion swaps instantly.
 */
export function MorphValue({ value, format, className }: { value: number; format: (v: number) => string; className?: string }) {
  const reduced = useLcReducedMotion()
  const mv = useSpring(value, { stiffness: LC_SPRING.morph.stiffness, damping: LC_SPRING.morph.damping, mass: LC_SPRING.morph.mass })
  const text = useTransform(mv, (v) => format(v))
  useEffect(() => {
    if (reduced) mv.jump(value)
    else mv.set(value)
  }, [value, reduced, mv])
  if (reduced) return <span className={className}>{format(value)}</span>
  return <motion.span className={className}>{text}</motion.span>
}
