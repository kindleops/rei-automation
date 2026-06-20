/**
 * Universal Deal Dossier Service
 * Re-exports canonical Deal Intelligence dossier builder.
 */
export {
  buildDealIntelligenceDossier,
  getUniversalDealDossier,
  runAcquisitionEngineWithProgress,
  ENGINE_PROGRESS_STAGES,
} from './deal-intelligence-dossier.js'

export { DEAL_DOSSIER_SCHEMA } from './deal-dossier-schema.js'