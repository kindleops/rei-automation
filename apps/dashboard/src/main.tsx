import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './modules/theme/nexus-theme.css'
import './dossier.css'
import './home-v2.css'
import './command-store.css'
import './acquisition.css'
import './styles/mobile-responsive.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
