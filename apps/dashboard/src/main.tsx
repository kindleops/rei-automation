import { createRoot } from 'react-dom/client'
import './index.css'
import './shared/fullscreen-app-shell.css'
import './styles/nexus-theme.css'
import './dossier.css'
import './styles/mobile-responsive.css'
import './modules/mobile/mobile-operating-shell.css'
import './modules/mobile/pinned-app-dock.css'
import './styles/nx-glass-system.css'
import './modules/shell/shell-primitives.css'
import './styles/nexus-theme-contract.css'
import { applyThemeToDOM } from './shared/settings'
import App from './App.tsx'

// Apply persisted theme+accent to <html> before React renders (prevents FOUC)
applyThemeToDOM()

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  let reloadScheduled = false
  const scheduleReload = () => {
    if (reloadScheduled) return
    reloadScheduled = true
    window.setTimeout(() => window.location.reload(), 120)
  }

  navigator.serviceWorker.addEventListener('message', (event: MessageEvent<{ type?: string }>) => {
    if (event.data?.type === 'NEXUS_SW_ACTIVATED') scheduleReload()
  })
  navigator.serviceWorker.addEventListener('controllerchange', scheduleReload)

  window.addEventListener('load', () => {
    void navigator.serviceWorker
      .register('/sw.js', { updateViaCache: 'none' })
      .then((registration) => {
        registration.update().catch(() => undefined)
        registration.addEventListener('updatefound', () => {
          const worker = registration.installing
          if (!worker) return
          worker.addEventListener('statechange', () => {
            if (worker.state === 'installed' && navigator.serviceWorker.controller) {
              worker.postMessage({ type: 'SKIP_WAITING' })
            }
          })
        })
      })
      .catch(() => undefined)
  })
}

// StrictMode intentionally double-mounts in dev, which aborts inbox fetches on
// the first mount and causes remount churn. Disabled during inbox stabilization.
createRoot(document.getElementById('root')!).render(
  <App />
)
