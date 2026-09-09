// GENERATED FILE -- overwritten by scripts/write-deploy-sha.mjs during `npm run build`.
//
// WHY THIS EXISTS (2026-09-09): production served commit 77334a4b from 04:05Z
// while the queue-runner container kept EXECUTING pre-cutover code for another
// ~11 hours. /api/version reported the new SHA the whole time, because that
// value comes from process.env.DEPLOY_GIT_SHA which the Worker hands to the
// container -- it describes what the Worker was TOLD to run, not what the
// container is actually running. The only proof of the stale runner was
// behavioural (blocked rows carrying a code constant the new commit deleted).
//
// BUILD_SHA below is CODE, not environment: it is inlined into the bundle at
// build time and travels with the image, so comparing it against the env SHA
// makes a stale or half-rolled runner visible directly.
//
// This placeholder is committed on purpose. Do NOT gitignore it -- a missing
// module here fails every import of the queue runner and /api/version at load
// time. Local dev and the test suite legitimately read "unknown".
export const BUILD_SHA = "unknown";
export const BUILD_TIMESTAMP = "unknown";
