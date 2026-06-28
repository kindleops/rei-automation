export {
  corsHeaders,
  workflowError,
  workflowSuccess,
  ensureMutationAuth,
} from '../_shared.js';

/** GET routes use the same ops-dashboard auth gate as mutations. */
export { ensureMutationAuth as ensureReadAuth } from '../_shared.js';