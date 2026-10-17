// EVALUATION ENTRY (rc-8.5.21). Every offline evaluation / replay of the conversation engine runs
// THIS function, which is decideAndCompose with caller 'evaluation' — the same function reference
// the live shadow, the turn job, R3 and the review drafts use. An evaluation therefore measures the
// code a canary would run (8.5.20 eval: the harness measured runConversationPipeline while the
// live shadow ran the R1 composer).
import { decideAndCompose } from './canonical.js'

export { decideAndCompose }

/** One replayed turn. Same arguments as decideAndCompose minus `caller`. */
export function replayTurnForEvaluation(args = {}) {
  return decideAndCompose({ ...args, caller: 'evaluation' })
}
