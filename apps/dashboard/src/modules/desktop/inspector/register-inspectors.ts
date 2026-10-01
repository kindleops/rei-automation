/**
 * The renderers the Universal Inspector knows. Each lives in ./renderers and
 * registers itself; this file only makes sure they are loaded with the plane.
 * (Renderers are added as their read contract is verified against the
 * owning app's endpoint — a type without one shows an honest "not
 * inspectable yet" note instead of a guessed panel.)
 */
export {}
