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
import './modules/mobile/mobile-edge-chrome.css'
import './styles/liquid-glass-controls.css'
import './shared/lc/lc-tokens.css'
import './shared/lc/lc-base.css'
import { applyThemeToDOM } from './shared/settings'
import App from './App.tsx'
import { LcMotionRoot } from './shared/lc/MotionRoot'
import { installBuildFreshness } from './shared/build-freshness/install'
import { BuildFreshnessNotice } from './shared/build-freshness/BuildFreshnessNotice'
import { CommandWallBoot } from './modules/command-wall/CommandWallBoot'
import { isCommandWallPath } from './modules/command-wall/wall-path'

// Apply persisted theme+accent to <html> before React renders (prevents FOUC)
applyThemeToDOM()

// Stale-deploy recovery: a tab running a replaced build reloads once toward the
// new one when an app chunk is gone, and a 5-min/focus poll offers a Reload pill.
installBuildFreshness()

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  let reloadScheduled = false
  const scheduleReload = () => {
    if (reloadScheduled) return
    reloadScheduled = true
    window.setTimeout(() => window.location.reload(), 120)
  }

  navigator.serviceWorker.addEventListener('message', (event: MessageEvent<{ type?: string; url?: string }>) => {
    if (event.data?.type === 'NEXUS_SW_ACTIVATED') scheduleReload()
    // A tapped phone alert, when the worker cannot navigate the window itself.
    // The worker posted this for months with nobody listening.
    if (event.data?.type === 'NEXUS_PUSH_NAVIGATE' && event.data.url) {
      const target = new URL(event.data.url, window.location.origin)
      if (target.origin === window.location.origin) {
        void import('./app/router').then(({ pushRoutePath }) => pushRoutePath(`${target.pathname}${target.search}`))
      }
    }
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
//
// COMMAND WALL (/wall, /wall/diagnostics) is a separate TV-native client: it
// authenticates as a paired DISPLAY, never as an operator, so it must mount
// before App's AuthProvider/RequireAuth and outside every operator shell.
createRoot(document.getElementById('root')!).render(
  isCommandWallPath(window.location.pathname) ? (
    <LcMotionRoot>
      <CommandWallBoot />
    </LcMotionRoot>
  ) : (
    <LcMotionRoot>
      <App />
      <BuildFreshnessNotice />
    </LcMotionRoot>
  )
)
