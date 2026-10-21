// PACKAGE A (hotfix/research-runtime): the Operations API routes (app/api/cockpit/agent/operations/*,
// byte-identical to rc-8.5.21) import their services from here. The composition root is
// research-runtime-wiring.js; this module only re-exports it, so there is ONE pool / store per process.
export { getOperationsServices, getOperationsRouteServices } from './research-runtime-wiring.js'
