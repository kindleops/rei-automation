// Runtime warning for legacy attempts
export const checkLegacyImport = (componentName: string) => {
  if (typeof window !== 'undefined' && (window as any).process?.env?.NODE_ENV === 'development') {
    console.warn(`[DOSSIER REGRESSION] Legacy dossier component "${componentName}" imported. Use CanonicalDossier.`)
  }
}
