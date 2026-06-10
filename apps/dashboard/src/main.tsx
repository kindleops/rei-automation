import { createRoot } from 'react-dom/client'
import './index.css'
import './styles/nexus-theme.css'
import './dossier.css'
import './home-v2.css'
import './acquisition.css'
import './styles/mobile-responsive.css'
import './styles/light-theme-premium.css'
import './styles/nx-glass-system.css'
import './styles/nx-ui-foundation-final.css'
import { applyThemeToDOM } from './shared/settings'
import App from './App.tsx'

// Apply persisted theme+accent to <html> before React renders (prevents FOUC)
applyThemeToDOM()

// StrictMode intentionally double-mounts in dev, which aborts inbox fetches on
// the first mount and causes remount churn. Disabled during inbox stabilization.
createRoot(document.getElementById('root')!).render(
  <App />
)
