import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RuntimeProvider } from './ui/store'
import { App } from './ui/App'
import './ui/styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RuntimeProvider>
      <App />
    </RuntimeProvider>
  </StrictMode>,
)
