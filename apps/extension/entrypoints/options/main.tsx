import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { SettingsPage } from '../../src/settings/SettingsPage.tsx'
import '../../src/styles.css'

const scheme = matchMedia('(prefers-color-scheme: light)')
document.documentElement.dataset.theme = scheme.matches ? 'light' : 'dark'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SettingsPage />
  </StrictMode>,
)
