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
import { startViewportRuntime } from './modules/mobile/viewport-runtime'
import App from './App.tsx'

// Apply persisted theme+accent to <html> before React renders (prevents FOUC)
applyThemeToDOM()

// Publish the true visible viewport (--nx-vvh / --nx-vv-bottom-gap) before first
// paint so the shell and the bottom dock never lay out against a stale height.
startViewportRuntime()

// ── Service worker: unregistered on purpose ───────────────────────────────
//
// This build deliberately does NOT register a service worker, and actively
// removes any that a previous build installed.
//
// Why: with a SW in play the first load comes from the network and later loads
// are answered by the worker, so "it was full-screen, then I refreshed and it
// wasn't" is exactly the shape a SW produces — two different asset sets across
// two loads of the same URL. The old registration also force-reloaded the page
// on `controllerchange`, which meant a deploy could reload an already-running
// app into a different build mid-session.
//
// An installed test preview gains nothing from offline caching and loses the
// ability to reason about what is on screen, so the trade is not close. The
// purge below also cleans up workers already installed on a handset.
if ('serviceWorker' in navigator) {
  void navigator.serviceWorker.getRegistrations()
    .then((regs) => Promise.all(regs.map((r) => r.unregister())))
    .then(() => (typeof caches !== 'undefined' ? caches.keys() : Promise.resolve([])))
    .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
    .catch(() => undefined)
}

// StrictMode intentionally double-mounts in dev, which aborts inbox fetches on
// the first mount and causes remount churn. Disabled during inbox stabilization.
createRoot(document.getElementById('root')!).render(
  <App />
)
