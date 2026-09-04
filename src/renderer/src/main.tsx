import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import OverlayApp from './overlay/OverlayApp'
import QuickAskApp from './quickask/QuickAskApp'
import { ThemeProvider } from '../../theme/theme'

const rootElement = document.getElementById('root') as HTMLElement

// todo38: the screenshot ask-overlay opens as a SECOND renderer surface on the
// same bundle, addressed by '#/overlay' (main/overlay/electronDeps.ts loads it).
// It deliberately skips the whole app shell (nav/router/theme/Toaster): a
// pixel-exact fullscreen capture backdrop must not carry app chrome, and the
// overlay's IPC surface is the three overlay:* channels only.
// todo41 (SAME WIRING): '#/quickask' is the quick-ask mini window surface —
// also shell-free; its IPC surface is quickask:* only (ask/hide/prefill:get +
// the quickask:* stream events).
if (window.location.hash === '#/overlay') {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <OverlayApp />
    </React.StrictMode>,
  )
} else if (window.location.hash === '#/quickask') {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <QuickAskApp />
    </React.StrictMode>,
  )
} else {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </React.StrictMode>,
  )
}
