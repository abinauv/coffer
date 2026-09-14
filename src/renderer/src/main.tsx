import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { applyStoredDensity } from './store/density'
import { applyStoredTheme } from './store/theme'
import './styles/index.css'

/* Before the first render, not inside it. The CSP forbids the inline script a web
 * app would use for this, so the attribute is written here instead — still ahead
 * of first paint, which is the only thing that matters. Without it, a user on
 * explicit dark sees one frame of light paper at every launch. */
applyStoredTheme()
applyStoredDensity()

const container = document.getElementById('root')
if (!container) throw new Error('Root element not found')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
